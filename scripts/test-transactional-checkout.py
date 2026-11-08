#!/usr/bin/env python3
"""
scripts/test-transactional-checkout.py
Pengujian Workload Transaksional Checkout Terisolasi (P3 Stack)
Hardened version with opt-in cleanup, shared operation lock and recovery guard.

Menguji kapasitas, atomisitas, idempotensi, dan integritas transaksi checkout
secara terisolasi dan aman untuk dieksekusi berulang kali:
1. Database Identity & Writer Dynamic Resolution:
   - Target database WAJIB 'flashsale_p3'.
   - Menolak koneksi jika mengarah ke database P2 ('flashsale').
   - Menemukan container primary writer aktif secara dinamis (in_recovery=false),
     sehingga tetap valid pasca failover jika replica telah dipromosikan.
2. Ingress API Identity Verification:
   - Memverifikasi endpoint /health bahwa API terhubung ke database 'flashsale_p3' writer.
3. Konkurensi & Mutasi Atomik:
   - Mengirimkan N transaksi checkout serentak dengan unique Idempotency-Key (p3-tx-<run_id>-<uuid>).
   - Memverifikasi status 201 CREATED dan pengurangan stok atomik.
4. Strict Idempotency Verification:
   - Mengulang N request dengan key yang sama persis.
   - Memvalidasi status 200, response body result='DUPLICATE'.
   - Memvalidasi bahwa jumlah order TIDAK bertambah dan stok TIDAK berkurang untuk kedua kalinya.
5. Proteksi Oversell:
   - Permintaan qty melebihi stok yang tersedia -> wajib ditolak dengan HTTP 409 SOLD_OUT.
6. Strict Verification via scripts/p3/cli.js verify:
   - Invarian database wajib konsisten (consistent: true, foreign_orders: 0).
7. Opt-in Atomic Cleanup with Baseline Verification (try/finally):
   - Menghitung jumlah aktual order yang dibuat oleh run_id ini (bukan asumsi concurrency).
   - Menghapus HANYA order dengan run_id tersebut dan mengembalikan stok terpakai secara atomik.
   - Row locking (SELECT ... FOR UPDATE) menjamin konkurensi aman.
   - Memverifikasi bahwa total pesanan dan stok kembali persis ke baseline awal.
   - Jika terdapat timeout, HTTP 5xx, future exception atau request belum pasti, cleanup ditangguhkan
     dan dilaporkan NEEDS_MANUAL_REVIEW.
   - Jika cleanup gagal atau baseline mismatch, test WAJIB keluar dengan exit code 1 (FAILED).
   - Default mempertahankan data; --cleanup hanya diizinkan setelah seluruh test sukses tanpa hasil ambigu.
   - Shared operation.lock dipegang sampai seluruh futures dan cleanup selesai; recovering/malformed manifest ditolak.
"""

import argparse
import concurrent.futures
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import os
from pathlib import Path
import threading

DEFAULT_URL = "http://127.0.0.1:8080"
ROOT = Path(__file__).resolve().parent.parent


class P3OperationLease:
    """Interoperable with scripts/p3/util.js: exclusive PID + token ownership.

    Never reclaim stale locks automatically. Hold through all futures/cleanup.
    """
    def __init__(self, runtime=None):
        self.runtime = Path(runtime) if runtime else ROOT / ".p3"
        self.path = self.runtime / "operation.lock"
        self.owner = {"pid": os.getpid(), "token": str(uuid.uuid4())}

    def __enter__(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.owner, stream)
                stream.flush()
                os.fsync(stream.fileno())
            self.check()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def check(self):
        if json.loads(self.path.read_text(encoding="utf-8")) != self.owner:
            raise RuntimeError("P3 operation.lock ownership changed; all writes blocked")
        manifest_path = self.runtime / "recovery.json"
        if manifest_path.exists():
            state = json.loads(manifest_path.read_text(encoding="utf-8"))
            if state.get("phase") != "validated" or state.get("project") != "flashsale-p3" or state.get("database") != "flashsale_p3":
                raise RuntimeError("Incomplete or invalid P3 recovery; transactions and cleanup blocked")

    def __exit__(self, *_args):
        # Preserve malformed, unreadable and replacement locks.
        try:
            if json.loads(self.path.read_text(encoding="utf-8")) == self.owner:
                self.path.unlink()
        except (OSError, ValueError):
            pass


def is_ambiguous_response(response):
    status = response.get("status", 0)
    return status == 0 or status >= 500


def http_request(url, method="GET", headers=None, data=None, timeout=10):
    t0 = time.time()
    req = urllib.request.Request(url, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    if data:
        req.data = json.dumps(data).encode("utf-8")
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - t0
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body.startswith(("[", "{")) else body
            return {
                "status": resp.status,
                "headers": dict(resp.getheaders()),
                "body": parsed,
                "elapsed_ms": round(elapsed * 1000, 2),
            }
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body = e.read().decode("utf-8")
        parsed = json.loads(body) if body.startswith(("[", "{")) else body
        return {
            "status": e.code,
            "headers": dict(e.headers.items()),
            "body": parsed,
            "elapsed_ms": round(elapsed * 1000, 2),
        }
    except Exception as e:
        elapsed = time.time() - t0
        return {"status": 0, "error": str(e), "elapsed_ms": round(elapsed * 1000, 2)}


def run_p3_verify():
    try:
        proc = subprocess.run(
            ["node", "scripts/p3/cli.js", "verify"],
            capture_output=True,
            text=True,
            timeout=25,
        )
        if proc.returncode != 0:
            return False, f"Exit code {proc.returncode}: {proc.stderr.strip()}", None
        data = json.loads(proc.stdout)
        return True, None, data
    except Exception as e:
        return False, str(e), None


def resolve_p3_writer():
    """
    Menemukan container database P3 yang aktif sebagai primary writer (in_recovery=false).
    Mendukung skenario pasca-failover di mana writer berpindah ke replica yang telah dipromosikan.
    Menolak database selain 'flashsale_p3' (mencegah kontaminasi ke P2).
    """
    candidates = ["flashsale-p3-db-primary-1", "flashsale-p3-db-replica-1"]
    active_writers = []

    for cname in candidates:
        cmd = ["docker", "exec", cname, "psql", "-U", "p3_admin", "-d", "flashsale_p3", "-AtXc", "SELECT current_database(), pg_is_in_recovery()"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            if res.returncode == 0 and res.stdout.strip():
                parts = res.stdout.strip().split("|")
                db_name = parts[0]
                in_rec = parts[1] if len(parts) > 1 else ""
                if db_name == "flashsale_p3" and in_rec == "f":
                    active_writers.append(cname)
                elif db_name != "flashsale_p3":
                    raise AssertionError(f"Kontaminasi database terdeteksi pada {cname}: database '{db_name}' bukan 'flashsale_p3'!")
        except Exception:
            continue

    if len(active_writers) == 0:
        raise AssertionError("Gagal menemukan database writer aktif untuk stack P3 (in_recovery=false). Fail-closed.")
    if len(active_writers) > 1:
        raise AssertionError(f"Split-brain terdeteksi pada stack P3: lebih dari 1 container writer aktif ({active_writers})!")

    return active_writers[0]


def query_p3_db(sql, writer_container):
    cmd = ["docker", "exec", writer_container, "psql", "-U", "p3_admin", "-d", "flashsale_p3", "-AtXc", sql]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    return res.returncode == 0, res.stdout.strip(), res.stderr.strip()


def exact_atomic_cleanup(run_id, target_product_id, writer_container, *, lease):
    """
    Menghapus hanya order yang memiliki prefix run_id, menghitung total quantity
    yang benar-benar dihapus, dan mengembalikan stok produk yang bersangkutan
    dalam satu transaksi atomik dengan row locking.
    """
    lease.check()
    cleanup_sql = (
        f"BEGIN; "
        f"SELECT stock FROM products WHERE id = {target_product_id} FOR UPDATE; "
        f"WITH target_orders AS ( "
        f"  SELECT id, product_id, qty "
        f"  FROM orders "
        f"  WHERE idempotency_key LIKE '{run_id}%' "
        f"), "
        f"deleted_orders AS ( "
        f"  DELETE FROM orders "
        f"  WHERE id IN (SELECT id FROM target_orders) "
        f"  RETURNING product_id, qty "
        f"), "
        f"restored_stock AS ( "
        f"  UPDATE products p "
        f"  SET stock = p.stock + del.total_qty "
        f"  FROM ( "
        f"    SELECT product_id, SUM(qty) AS total_qty "
        f"    FROM deleted_orders "
        f"    GROUP BY product_id "
        f"  ) del "
        f"  WHERE p.id = del.product_id "
        f"  RETURNING p.id, p.stock, del.total_qty "
        f") "
        f"SELECT "
        f"  (SELECT COUNT(*) FROM target_orders) AS del_count, "
        f"  COALESCE((SELECT SUM(total_qty) FROM restored_stock), 0) AS res_qty; "
        f"COMMIT;"
    )
    ok, stdout, stderr = query_p3_db(cleanup_sql, writer_container)
    if not ok:
        return False, 0, 0, f"Database cleanup query failed: {stderr}"

    # stdout format: "del_count|res_qty" (or multiple lines)
    del_count = 0
    res_qty = 0
    for line in stdout.splitlines():
        if "|" in line:
            parts = line.split("|")
            try:
                del_count = int(parts[0])
                res_qty = int(parts[1])
            except (ValueError, IndexError):
                pass

    return True, del_count, res_qty, None


def parse_args():
    parser = argparse.ArgumentParser(
        description="Pengujian Transaksional Checkout Terisolasi (P3)"
    )
    parser.add_argument(
        "--url", default=DEFAULT_URL, help="Base URL ingress P3 (default: http://127.0.0.1:8080)"
    )
    parser.add_argument(
        "--concurrency", type=int, default=10, help="Jumlah request checkout serentak (default: 10)"
    )
    parser.add_argument(
        "--product-id", type=int, default=1, help="ID Produk yang diuji (default: 1)"
    )
    cleanup = parser.add_mutually_exclusive_group()
    cleanup.add_argument("--cleanup", action="store_true", help="Opt-in cleanup hanya setelah seluruh test sukses tanpa hasil ambigu")
    cleanup.add_argument("--no-cleanup", action="store_true", help="Kompatibilitas: pertahankan data (sudah menjadi default)")
    return parser.parse_args()


def main():
    args = parse_args()
    with P3OperationLease() as lease:
        # Reuse the authoritative Node validator, including P3 identity and full
        # recovery manifest validation, before any request or DB operation.
        checked = subprocess.run(["node", "-e",
            "const c=require('./scripts/p3/config').loadConfig(); require('./scripts/p3/recovery').assertRecoveryComplete(c);"],
            cwd=ROOT, capture_output=True, text=True, timeout=15)
        if checked.returncode != 0:
            raise RuntimeError("P3 recovery/configuration preflight rejected: " + checked.stderr.strip())
        run_test(args, lease)


def run_test(args, lease):
    base_url = args.url
    concurrency = args.concurrency
    target_product_id = args.product_id
    should_cleanup = args.cleanup
    run_id = f"p3-tx-{uuid.uuid4().hex[:8]}"

    if concurrency <= 0:
        print("[FAIL] Nilai concurrency harus integer positif.")
        sys.exit(1)
    if target_product_id <= 0:
        print("[FAIL] Nilai product-id harus integer positif.")
        sys.exit(1)

    print("=" * 80)
    print("PENGUJIAN WORKLOAD TRANSAKSIONAL CHECKOUT TERISOLASI (P3 STACK)")
    print(f"Target Ingress   : {base_url}")
    print(f"Run ID           : {run_id}")
    print(f"Concurrency      : {concurrency} thread")
    print(f"Target Product ID: {target_product_id}")
    print(f"Auto Cleanup     : {should_cleanup}")
    print("=" * 80)

    # -----------------------------------------------------------------
    # Baseline Metrics Storage
    # -----------------------------------------------------------------
    initial_orders = None
    initial_stock = None
    initial_run_orders = None
    active_writer = None

    test_failed = False
    test_failure_reason = ""
    cleanup_failed = False
    cleanup_failure_reason = ""
    has_ambiguous_requests = False
    uncertainty = threading.Event()
    pending = set()
    pending_lock = threading.Lock()

    try:
        # -----------------------------------------------------------------
        # 1. Pre-Flight Verification & Database Identity Check
        # -----------------------------------------------------------------
        print("\n[FASE 1: Verifikasi Identitas Database P3 & Kondisi Awal Ingress]")
        health = http_request(f"{base_url}/health")
        if health["status"] != 200:
            raise AssertionError(f"Ingress {base_url}/health gagal (status: {health['status']}, error: {health.get('error')})")

        health_body = health.get("body", {})
        api_db = health_body.get("database")
        api_in_rec = health_body.get("in_recovery")
        print(f"  - Ingress Healthcheck OK: status=200, db={health_body.get('db')}, database={api_db}, in_recovery={api_in_rec}")

        # Validasi API Destination Identity
        if api_db and api_db != "flashsale_p3":
            raise AssertionError(f"API destination mismatch: Ingress terhubung ke database '{api_db}', bukan 'flashsale_p3'! Dibatalkan.")
        if api_in_rec is True:
            raise AssertionError("API destination target terhubung ke database standby (in_recovery=true); wajib writer aktif!")

        # Resolusi Database Writer Aktif P3 secara Dinamis
        active_writer = resolve_p3_writer()
        print(f"  - Database Writer Aktif : {active_writer} (terverifikasi flashsale_p3, in_recovery=false)")

        ok, err, initial_verify = run_p3_verify()
        if not ok or not initial_verify:
            raise AssertionError(f"Gagal menjalankan p3:verify awal: {err}")

        pri_db = initial_verify.get("primary", {}).get("database")
        rep_db = initial_verify.get("replica", {}).get("database")
        pri_standby = initial_verify.get("primary", {}).get("standby")
        rep_standby = initial_verify.get("replica", {}).get("standby")
        init_consistent = initial_verify.get("consistent", False)

        print(f"  - Database Primary: '{pri_db}' (standby={pri_standby})")
        print(f"  - Database Replica: '{rep_db}' (standby={rep_standby})")
        print(f"  - Invarian Awal   : consistent={init_consistent}, foreign_orders={initial_verify.get('primary', {}).get('foreign_orders')}")

        if pri_db != "flashsale_p3" or rep_db != "flashsale_p3":
            raise AssertionError(f"Target database BUKAN 'flashsale_p3'! Terdeteksi: primary='{pri_db}', replica='{rep_db}'.")
        if not init_consistent:
            raise AssertionError("Database P3 tidak konsisten sebelum pengujian dimulai!")
        print("  [ASSERTION PASS] Identitas database terkonfirmasi stack P3 (flashsale_p3) dan konsisten.")

        initial_stats = http_request(f"{base_url}/stats")
        if initial_stats["status"] != 200 or not isinstance(initial_stats["body"], dict):
            raise AssertionError(f"Ingress {base_url}/stats gagal (status: {initial_stats['status']})")

        s_body = initial_stats["body"]
        initial_orders = s_body.get("total_orders", 0)
        target_prod_initial = next((p for p in s_body.get("products", []) if p["id"] == target_product_id), None)
        if not target_prod_initial:
            raise AssertionError(f"Produk dengan ID {target_product_id} tidak ditemukan di database!")

        initial_stock = target_prod_initial["stock"]

        # Verifikasi baseline bahwa tidak ada order dengan run_id ini sebelum pengujian
        q_ok, q_out, q_err = query_p3_db(f"SELECT COUNT(*) FROM orders WHERE idempotency_key LIKE '{run_id}%'", active_writer)
        if not q_ok or not q_out.strip().isdigit():
            raise AssertionError(f"Gagal memeriksa baseline run orders: query database gagal ({q_err or q_out})")

        initial_run_orders = int(q_out.strip())
        if initial_run_orders != 0:
            raise AssertionError(f"Run ID '{run_id}' sudah memiliki order sebelumnya ({initial_run_orders} orders)!")

        print(f"  - Total Orders Awal: {initial_orders}")
        print(f"  - Stok Awal Produk '{target_prod_initial['name']}': {initial_stock}")
        print(f"  - Order untuk Run ID Awal: {initial_run_orders}")

        # -----------------------------------------------------------------
        # 2. Concurrent Checkout Phase (Atomicity)
        # -----------------------------------------------------------------
        print(f"\n[FASE 2: Eksekusi {concurrency} Transaksi Checkout Serentak (Atomik)]")
        keys = [f"{run_id}-{uuid.uuid4()}" for _ in range(concurrency)]

        def send_checkout(key, qty=1):
            body = {"user_id": 1, "product_id": target_product_id, "qty": qty}
            headers = {"Idempotency-Key": key}
            lease.check()
            with pending_lock:
                pending.add(key)
            try:
                response = http_request(f"{base_url}/checkout", method="POST", headers=headers, data=body)
                if is_ambiguous_response(response):
                    uncertainty.set()
                with pending_lock:
                    pending.discard(key)
                return key, response
            except BaseException:
                uncertainty.set()
                raise

        results_phase2 = []
        t_start = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(send_checkout, k, 1) for k in keys]
            for f in concurrent.futures.as_completed(futures):
                results_phase2.append(f.result())
        t_elapsed = time.time() - t_start

        statuses = {}
        created_orders = []
        for k, resp in results_phase2:
            st = resp["status"]
            statuses[st] = statuses.get(st, 0) + 1
            if st == 201:
                created_orders.append((k, resp["body"]))
            elif st == 0 or st >= 500:
                has_ambiguous_requests = True

        print(f"  - Request selesai dalam: {round(t_elapsed * 1000, 2)} ms")
        print(f"  - Distribusi Status HTTP: {statuses}")
        print(f"  - Total Order 201 CREATED: {len(created_orders)} / {concurrency}")

        if statuses.get(201, 0) != concurrency:
            raise AssertionError(f"Diharapkan {concurrency} status 201 CREATED, didapat {statuses.get(201, 0)}")
        print("  [ASSERTION PASS] Seluruh checkout konkuren berhasil dibuat (201 CREATED).")

        # -----------------------------------------------------------------
        # 3. Strict Idempotency Verification
        # -----------------------------------------------------------------
        print(f"\n[FASE 3: Validasi Idempotency Ketat - Mengulang {concurrency} Request dengan Key Sama]")
        results_phase3 = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(send_checkout, k, 1) for k in keys]
            for f in concurrent.futures.as_completed(futures):
                results_phase3.append(f.result())

        duplicate_statuses = {}
        duplicate_orders = []
        for k, resp in results_phase3:
            st = resp["status"]
            duplicate_statuses[st] = duplicate_statuses.get(st, 0) + 1
            if st == 200 and isinstance(resp.get("body"), dict) and resp["body"].get("result") == "DUPLICATE":
                duplicate_orders.append((k, resp["body"]))
            elif st == 0 or st >= 500:
                has_ambiguous_requests = True

        print(f"  - Distribusi Status Retry: {duplicate_statuses}")
        print(f"  - Total Order 200 DUPLICATE: {len(duplicate_orders)} / {concurrency}")

        if duplicate_statuses.get(200, 0) != concurrency or len(duplicate_orders) != concurrency:
            raise AssertionError(f"Idempotency response tidak valid! Diharapkan {concurrency} DUPLICATE body, didapat {len(duplicate_orders)}")

        stats_after_retry = http_request(f"{base_url}/stats")
        if stats_after_retry["status"] != 200:
            raise AssertionError("Gagal memeriksa /stats pasca retry idempotensi!")

        orders_after_retry = stats_after_retry["body"].get("total_orders", 0)
        stock_after_retry = next(p["stock"] for p in stats_after_retry["body"].get("products", []) if p["id"] == target_product_id)

        expected_orders_after_checkout = initial_orders + concurrency
        expected_stock_after_checkout = initial_stock - concurrency

        print(f"  - Verifikasi Mutasi Pasca Retry:")
        print(f"    * Orders: {orders_after_retry} (Expected: {expected_orders_after_checkout})")
        print(f"    * Stock : {stock_after_retry} (Expected: {expected_stock_after_checkout})")

        if orders_after_retry != expected_orders_after_checkout:
            raise AssertionError(f"Jumlah order bertambah saat retry idempotensi! (Expected {expected_orders_after_checkout}, got {orders_after_retry})")
        if stock_after_retry != expected_stock_after_checkout:
            raise AssertionError(f"Stok berkurang untuk kedua kalinya saat retry idempotensi! (Expected {expected_stock_after_checkout}, got {stock_after_retry})")
        print("  [ASSERTION PASS] Proteksi idempotency terbukti valid: jumlah pesanan dan stok tidak bermutasi ganda.")

        # -----------------------------------------------------------------
        # 4. Oversell Protection Phase
        # -----------------------------------------------------------------
        print("\n[FASE 4: Validasi Proteksi Oversell (Stok Tidak Mencukupi)]")
        oversell_key = f"{run_id}-oversell-{uuid.uuid4()}"
        oversell_body = {"user_id": 1, "product_id": target_product_id, "qty": initial_stock + 1000}
        _, oversell_resp = send_checkout(oversell_key, qty=oversell_body["qty"])
        print(f"  - Respons Permintaan Melebihi Stok: status={oversell_resp['status']}, body={oversell_resp['body']}")

        if oversell_resp["status"] != 409 or oversell_resp["body"].get("error") != "SOLD_OUT":
            raise AssertionError(f"Proteksi oversell gagal! Diharapkan HTTP 409 SOLD_OUT, didapat {oversell_resp['status']}")
        print("  [ASSERTION PASS] Proteksi oversell valid: pesanan melebihi stok ditolak dengan 409 SOLD_OUT.")

        # -----------------------------------------------------------------
        # 5. Database Consistency Verification Post-Test (/stats)
        # -----------------------------------------------------------------
        print("\n[FASE 5: Verifikasi Invarian Database Pasca Pengujian (/stats)]")
        final_stats = http_request(f"{base_url}/stats")
        if final_stats["status"] != 200 or not isinstance(final_stats["body"], dict):
            raise AssertionError("Gagal membaca /stats pasca pengujian!")

        f_body = final_stats["body"]
        target_prod_final = next((p for p in f_body.get("products", []) if p["id"] == target_product_id), None)
        actual_stock = target_prod_final["stock"]

        print(f"  - Negative Stock      : {f_body.get('negative_stock')}")
        print(f"  - Duplicate Orders    : {f_body.get('duplicate_orders')}")
        print(f"  - Mismatched Products : {f_body.get('mismatched_products')}")
        print(f"  - Status Konsistensi  : {f_body.get('consistent')}")

        if not f_body.get("consistent"):
            raise AssertionError("Database tidak konsisten setelah pengujian!")
        if actual_stock != expected_stock_after_checkout:
            raise AssertionError(f"Ketidaksesuaian stok! Diharapkan {expected_stock_after_checkout}, aktual {actual_stock}")
        if f_body.get("negative_stock") != 0 or f_body.get("duplicate_orders") != 0 or f_body.get("mismatched_products") != 0:
            raise AssertionError("Invarian integritas terlanggar!")
        print("  [ASSERTION PASS] Invarian integritas database valid (/stats konsisten).")

        # -----------------------------------------------------------------
        # 6. Strict Verification via scripts/p3/cli.js verify
        # -----------------------------------------------------------------
        print("\n[FASE 6: Verifikasi Replikasi & Integritas via scripts/p3/cli.js verify]")
        ok, err_msg, verify_data = run_p3_verify()
        if not ok or not verify_data:
            raise AssertionError(f"'node scripts/p3/cli.js verify' GAGAL: {err_msg}")

        pri = verify_data.get("primary", {})
        rep = verify_data.get("replica", {})
        checkpoint = verify_data.get("checkpoint")
        p_orders = pri.get("orders")
        r_orders = rep.get("orders")
        p_foreign = pri.get("foreign_orders", 0)
        is_consistent = verify_data.get("consistent", False)

        print(f"  - Checkpoint Replication: {checkpoint}")
        print(f"  - Primary Orders        : {p_orders}, Foreign Orders: {p_foreign}")
        print(f"  - Replica Orders        : {r_orders}, Standby: {rep.get('standby')}")
        print(f"  - Consistent Status     : {is_consistent}")

        if not is_consistent:
            raise AssertionError("p3:verify melaporkan consistent = false!")
        if p_foreign > 0:
            raise AssertionError(f"Terdeteksi {p_foreign} foreign orders pada database P3!")
        if p_orders != r_orders:
            raise AssertionError(f"Replikasi desinkronisasi: primary ({p_orders}) != replica ({r_orders})!")
        print("  [ASSERTION PASS] Verifikasi replikasi p3:verify SUKSES PENUH (consistent=true, foreign_orders=0).")

    except Exception as e:
        test_failed = True
        test_failure_reason = str(e)
        print(f"\n[TEST EXCEPTION/FAILURE] {test_failure_reason}")

    finally:
        # -----------------------------------------------------------------
        # 7. Best-Effort Atomic Cleanup Phase
        # -----------------------------------------------------------------
        if should_cleanup:
            print(f"\n[FASE 7: Best-Effort Exact Cleanup Data Pengujian Run '{run_id}']")
            if has_ambiguous_requests or uncertainty.is_set() or pending:
                cleanup_failed = True
                cleanup_failure_reason = f"NEEDS_MANUAL_REVIEW: Ada timeout/status 0, HTTP 5xx, exception atau request belum pasti pada run '{run_id}'. Cleanup ditangguhkan; pertahankan bukti order."
                print(f"  [NEEDS_MANUAL_REVIEW] {cleanup_failure_reason}")
                print(f"  Jalankan peninjauan manual atau bersihkan order dengan run ID '{run_id}' setelah koneksi stabil.")
            elif test_failed:
                cleanup_failed = True
                cleanup_failure_reason = "Test gagal; cleanup dibatalkan dan data dipertahankan untuk review."
                print(f"  [NEEDS_MANUAL_REVIEW] {cleanup_failure_reason}")
            elif not active_writer:
                cleanup_failed = True
                cleanup_failure_reason = "Writer database tidak teridentifikasi; pembersihan dibatalkan (fail-closed)."
                print(f"  [FAIL] {cleanup_failure_reason}")
            else:
                clean_ok, deleted_count, restored_qty, clean_err = exact_atomic_cleanup(run_id, target_product_id, active_writer, lease=lease)
                if not clean_ok:
                    cleanup_failed = True
                    cleanup_failure_reason = f"Cleanup atomik gagal: {clean_err}"
                    print(f"  [FAIL] {cleanup_failure_reason}")
                else:
                    print(f"  - Hasil Cleanup Atomik: {deleted_count} order dihapus, {restored_qty} stok dikembalikan.")

                    # Verifikasi Baseline Pasca Cleanup
                    if initial_orders is not None and initial_stock is not None:
                        # 1. Pastikan tidak ada order dengan run_id tersisa
                        q_ok, q_out, q_err = query_p3_db(f"SELECT COUNT(*) FROM orders WHERE idempotency_key LIKE '{run_id}%'", active_writer)
                        remaining_run_orders = int(q_out.strip()) if q_ok and q_out.strip().isdigit() else -1

                        # 2. Cek stats aktual
                        post_clean_stats = http_request(f"{base_url}/stats")
                        if post_clean_stats["status"] != 200 or not isinstance(post_clean_stats.get("body"), dict):
                            cleanup_failed = True
                            cleanup_failure_reason = "Gagal memverifikasi /stats pasca cleanup"
                            print(f"  [FAIL] {cleanup_failure_reason}")
                        else:
                            post_body = post_clean_stats["body"]
                            post_orders = post_body.get("total_orders", 0)
                            post_prod = next((p for p in post_body.get("products", []) if p["id"] == target_product_id), None)
                            post_stock = post_prod["stock"] if post_prod else -1
                            post_consistent = post_body.get("consistent", False)

                            print(f"  - Verifikasi Baseline:")
                            print(f"    * Run Orders Sisa: {remaining_run_orders} (Expected: 0)")
                            print(f"    * Total Orders   : {post_orders} (Baseline: {initial_orders})")
                            print(f"    * Stok Produk    : {post_stock} (Baseline: {initial_stock})")
                            print(f"    * Konsistensi    : {post_consistent}")

                            if remaining_run_orders != 0:
                                cleanup_failed = True
                                cleanup_failure_reason = f"Order run '{run_id}' masih tersisa {remaining_run_orders} di DB!"
                            elif post_orders != initial_orders:
                                cleanup_failed = True
                                cleanup_failure_reason = f"Total order ({post_orders}) tidak kembali ke baseline ({initial_orders})!"
                            elif post_stock != initial_stock:
                                cleanup_failed = True
                                cleanup_failure_reason = f"Stok produk ({post_stock}) tidak kembali ke baseline ({initial_stock})!"
                            elif not post_consistent:
                                cleanup_failed = True
                                cleanup_failure_reason = "Database tidak konsisten pasca cleanup!"
                            else:
                                print("  [ASSERTION PASS] Baseline database terbukti pulih sempurna 100%.")
        else:
            print(f"\n[INFO] Cleanup tidak diaktifkan; data dipertahankan secara default.")
            if has_ambiguous_requests or uncertainty.is_set() or pending:
                print(f"  [NEEDS_MANUAL_REVIEW] Hasil transaksi belum pasti untuk run '{run_id}'; jangan hapus order sebelum rekonsiliasi.")
            print(f"  Data pesanan run '{run_id}' tetap tersimpan di database.")
            print("  Baseline TIDAK dipulihkan.")

    # -----------------------------------------------------------------
    # Final Result Assessment
    # -----------------------------------------------------------------
    print("\n" + "=" * 80)
    if cleanup_failed:
        print(f"HASIL: FAILED - Cleanup atau Baseline Verification Gagal: {cleanup_failure_reason}")
        print("=" * 80)
        sys.exit(1)

    if test_failed:
        print(f"HASIL: FAILED - Pengujian Transaksi Gagal: {test_failure_reason}")
        print("=" * 80)
        sys.exit(1)

    if not should_cleanup:
        print("HASIL: PASS_WITH_DATA_RETAINED (Semua asersi transaksi lolos, data dipertahankan)")
        print("=" * 80)
        sys.exit(0)

    print("HASIL: PENGUJIAN WORKLOAD TRANSAKSIONAL CHECKOUT BERHASIL PENUH (PASS)")
    print("=" * 80)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[FAIL-CLOSED] {error}")
        sys.exit(1)
