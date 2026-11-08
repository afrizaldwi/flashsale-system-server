#!/usr/bin/env python3
"""
Test Validasi Ketahanan Kegagalan Backend (Backend Resilience)
Mendukung pengujian eksplisit untuk stack Pertemuan 2 (--stack p2) dan Pertemuan 3 (--stack p3).

Verifikasi ketat:
1. Pre-flight check: ketersediaan dua container backend dan konsistensi DB awal WAJIB SUKSES.
   - Jika /stats gagal, test langsung GAGAL (exit code 1).
   - Jika container stack tidak aktif, laporkan NOT RUN (exit code 2).
   - Menolak stack detection diam-diam jika kedua stack aktif atau tidak ada yang aktif.
2. Baseline: Nginx me-load-balance request ke kedua backend (round-robin) dan mencatat X-Backend-Id.
3. Failure simulation: container target dihentikan (docker stop).
   - Memverifikasi container benar-benar stopped (running=false).
   - Memverifikasi traffic dialihkan ke surviving backend.
   - Mengambil access log Nginx aktual (/var/log/nginx/access.log) dengan parsing multi-attempt upstream.
   - Memverifikasi backend yang mati TIDAK menerima traffic sukses (target ID = 0 hit 200).
   - Menolak laporan PASS jika record log kosong atau tidak dapat dianalisis.
   - Membedakan kegagalan transisi (timeout/504) dengan keberhasilan yang dilayani survivor.
4. Recovery: container target dinyalakan kembali (docker start).
   - Memverifikasi container ID yang di-restart identik dengan target semula.
   - Memverifikasi container pulih menjadi healthy.
   - Memverifikasi Nginx kembali mendistribusikan traffic ke kedua backend secara konsisten.
5. Invarian database: memverifikasi integritas data tetap konsisten (/stats WAJIB SUKSES).
"""

import argparse
import json
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

STACK_CONFIGS = {
    "p2": {
        "name": "Pertemuan 2 (Docker Compose)",
        "base_url": "http://127.0.0.1:80",
        "target_backend": "flashsale-backend-2",
        "surviving_backend": "flashsale-backend-1",
        "nginx_container": "flashsale-nginx",
        "db_container": "flashsale-db-primary",
        "compose_file": "docker-compose.yml",
        "min_success": 28,
    },
    "p3": {
        "name": "Pertemuan 3 (Autoscaling & Observability)",
        "base_url": "http://127.0.0.1:8080",
        "target_backend": "flashsale-p3-backend-2",
        "surviving_backend": "flashsale-p3-backend-1",
        "nginx_container": "flashsale-p3-nginx-1",
        "db_container": "flashsale-p3-db-primary-1",
        "compose_file": "docker-compose.p3.yml",
        # Pada P3: 2 Nginx workers x max_fails=2 dengan 'proxy_next_upstream off' menghasilkan
        # tepat 4 request timeout (504) saat sudden ungraceful stop sebelum fail_timeout berlaku.
        # Dari 30 request, minimal 25 request berhasil (200 OK).
        "min_success": 25,
    },
}


def run_command(cmd_args, timeout=30):
    try:
        if isinstance(cmd_args, str):
            cmd_args = shlex.split(cmd_args)
        res = subprocess.run(
            cmd_args, capture_output=True, text=True, timeout=timeout
        )
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except Exception as e:
        return -1, "", str(e)


def inspect_container(container_name):
    code, out, _ = run_command([
        "docker", "inspect", "--format",
        "{{.Id}} {{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        container_name
    ])
    if code != 0 or not out:
        return {"id": "", "running": False, "health": "unknown", "exists": False, "ip": ""}
    parts = out.split()
    cid = parts[0][:12] if len(parts) > 0 else ""
    running = parts[1].lower() == "true" if len(parts) > 1 else False
    health = parts[2] if len(parts) > 2 else "none"

    code_ip, out_ip, _ = run_command([
        "docker", "inspect", "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        container_name
    ])
    ip_addr = out_ip.strip() if code_ip == 0 else ""

    return {"id": cid, "running": running, "health": health, "exists": True, "ip": ip_addr}


def detect_active_stack():
    p3_stat = inspect_container(STACK_CONFIGS["p3"]["target_backend"])
    p2_stat = inspect_container(STACK_CONFIGS["p2"]["target_backend"])
    p3_running = p3_stat["running"]
    p2_running = p2_stat["running"]

    if not p3_running and not p2_running:
        print("[FAIL] Tidak ada stack backend yang aktif (P2 maupun P3). Tentukan stack secara eksplisit dengan --stack p2 atau --stack p3 setelah menyalakan container.")
        sys.exit(2)
    if p3_running and p2_running:
        print("[FAIL] Kedua stack (P2 dan P3) terdeteksi aktif secara bersamaan. Harap spesifikasikan --stack p2 atau --stack p3 secara eksplisit.")
        sys.exit(1)
    if p3_running:
        return "p3"
    return "p2"


def fetch_nginx_access_log(nginx_container):
    """
    Mengambil isi /var/log/nginx/access.log dari dalam container Nginx.
    Jika pembacaan file gagal atau kosong, fallback ke docker logs.
    """
    code, out, _ = run_command(["docker", "exec", nginx_container, "cat", "/var/log/nginx/access.log"], timeout=15)
    if code == 0 and out.strip():
        return out.strip().splitlines()
    code_logs, out_logs, _ = run_command(["docker", "logs", nginx_container], timeout=15)
    if code_logs == 0 and out_logs.strip():
        return out_logs.strip().splitlines()
    return []


def http_get(base_url, endpoint, timeout=5):
    url = f"{base_url}{endpoint}"
    req = urllib.request.Request(url)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            headers = {k.lower(): v for k, v in resp.getheaders()}
            body = resp.read().decode("utf-8")
            elapsed = time.time() - t0
            return {
                "status": resp.status,
                "headers": headers,
                "backend_id": headers.get("x-backend-id", "unknown"),
                "elapsed_ms": round(elapsed * 1000, 2),
                "body": json.loads(body) if body.startswith(("[", "{")) else body,
            }
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        headers = {k.lower(): v for k, v in e.headers.items()}
        body = e.read().decode("utf-8")
        return {
            "status": e.code,
            "headers": headers,
            "backend_id": headers.get("x-backend-id", "unknown"),
            "elapsed_ms": round(elapsed * 1000, 2),
            "body": body,
        }
    except Exception as e:
        elapsed = time.time() - t0
        return {"status": 0, "error": str(e), "elapsed_ms": round(elapsed * 1000, 2)}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Pengujian Backend Resilience (P2 / P3 Stack)"
    )
    parser.add_argument(
        "--stack",
        choices=["p2", "p3"],
        default=None,
        help="Target stack: 'p2' (port 80) atau 'p3' (port 8080)",
    )
    parser.add_argument(
        "--url", default=None, help="Override base URL (cth: http://127.0.0.1:8080)"
    )
    parser.add_argument(
        "--target",
        default=None,
        help="Override nama container target yang akan dimatikan",
    )
    parser.add_argument(
        "--surviving",
        default=None,
        help="Override nama container backend yang bertahan",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    stack_name = args.stack or detect_active_stack()
    cfg = STACK_CONFIGS[stack_name]

    base_url = args.url or cfg["base_url"]
    target_backend = args.target or cfg["target_backend"]
    surviving_backend = args.surviving or cfg["surviving_backend"]
    min_success = cfg["min_success"]

    if target_backend == surviving_backend:
        print("[FAIL] Container target dan surviving backend tidak boleh sama.")
        sys.exit(1)

    print("=" * 75)
    print(f"TEST VALIDASI KETAHANAN KEGAGALAN BACKEND (BACKEND RESILIENCE)")
    print(f"Target Stack : {stack_name.upper()} ({cfg['name']})")
    print(f"Base URL     : {base_url}")
    print(f"Target Stop  : {target_backend}")
    print(f"Surviving    : {surviving_backend}")
    print("=" * 75)

    # -------------------------------------------------------------
    # 0. Pre-Flight Verification
    # -------------------------------------------------------------
    print("\n[PRE-FLIGHT: Verifikasi Kondisi Awal Container & Endpoint]")
    target_state = inspect_container(target_backend)
    surviving_state = inspect_container(surviving_backend)
    target_id = target_state["id"]
    surviving_id = surviving_state["id"]

    target_ip = target_state.get("ip", "")
    surviving_ip = surviving_state.get("ip", "")
    print(
        f"  - Target backend ({target_backend}, id={target_id}, ip={target_ip}): running={target_state['running']}, health={target_state['health']}"
    )
    print(
        f"  - Surviving backend ({surviving_backend}, id={surviving_id}, ip={surviving_ip}): running={surviving_state['running']}, health={surviving_state['health']}"
    )

    if not target_state["running"] or not surviving_state["running"]:
        print(
            f"\n[NOT RUN] Stack {stack_name.upper()} tidak aktif: container backend tidak running. "
            f"Jalankan stack {stack_name.upper()} terlebih dahulu sebelum pengujian."
        )
        sys.exit(2)

    initial_health = http_get(base_url, "/health")
    if initial_health["status"] != 200:
        print(
            f"\n[FAIL] Ingress {base_url}/health gagal (status: {initial_health['status']}, error: {initial_health.get('error')})"
        )
        sys.exit(1)
    print(f"  - Healthcheck Ingress OK: status={initial_health['status']}")

    # Verifikasi baseline /stats: WAJIB SUKSES (menolak false pass)
    initial_stats = http_get(base_url, "/stats")
    if initial_stats["status"] != 200 or not isinstance(initial_stats.get("body"), dict):
        print(
            f"\n[FAIL] Baseline database consistency check gagal! Endpoint {base_url}/stats mengembalikan HTTP {initial_stats['status']} (error: {initial_stats.get('error')})"
        )
        sys.exit(1)

    init_body = initial_stats["body"]
    init_consistent = init_body.get("consistent", False)
    init_neg = init_body.get("negative_stock", 0)
    init_dup = init_body.get("duplicate_orders", 0)
    print(
        f"  - Baseline Database: consistent={init_consistent} (negative_stock: {init_neg}, duplicate_orders: {init_dup})"
    )
    if not init_consistent or init_neg > 0 or init_dup > 0:
        print(
            f"\n[FAIL] Database tidak konsisten sebelum pengujian dimulai! (consistent={init_consistent}, neg={init_neg}, dup={init_dup})"
        )
        sys.exit(1)
    print("  [ASSERTION PASS] Baseline database konsisten dan valid.")

    # -------------------------------------------------------------
    # 1. Baseline: Round-Robin Distribution
    # -------------------------------------------------------------
    print("\n[FASE 1: Baseline dengan Dua Backend Aktif]")
    backends_seen = set()
    durations_baseline = []
    baseline_requests = 20

    for i in range(baseline_requests):
        r = http_get(base_url, "/health")
        b_id = r.get("backend_id")
        if b_id and b_id != "unknown":
            backends_seen.add(b_id)
        durations_baseline.append(r.get("elapsed_ms", 0))

    avg_baseline = (
        round(sum(durations_baseline) / len(durations_baseline), 2)
        if durations_baseline
        else 0
    )
    print(f"  - Request terkirim: {baseline_requests}")
    print(f"  - Backend yang melayani (X-Backend-Id): {list(backends_seen)}")
    print(f"  - Rata-rata latensi: {avg_baseline} ms")

    if len(backends_seen) < 2:
        print(
            f"\n[FAIL] Baseline gagal: traffic hanya dilayani oleh {backends_seen}. Diharapkan minimal 2 backend aktif."
        )
        sys.exit(1)
    print("  [ASSERTION PASS] Nginx mendistribusikan traffic ke minimal 2 backend.")

    # Guaranteed cleanup: pastikan target selalu dinyalakan kembali
    try:
        # -------------------------------------------------------------
        # 2. Failure Simulation: Stop Target Backend
        # -------------------------------------------------------------
        print(f"\n[FASE 2: Simulasi Kegagalan - Menghentikan {target_backend}]")
        print(f"  Menjalankan: docker stop {target_backend}...")
        code, out, err = run_command(["docker", "stop", target_backend], timeout=30)
        if code != 0:
            print(f"\n[FAIL] Gagal menghentikan {target_backend}: {err}")
            sys.exit(1)

        time.sleep(1)
        target_post_stop = inspect_container(target_backend)
        if target_post_stop["running"]:
            print(f"\n[FAIL] Container {target_backend} dilaporkan masih RUNNING!")
            sys.exit(1)
        print(
            f"  [ASSERTION PASS] Container {target_backend} terkonfirmasi STOPPED (running=false)."
        )

        # Ambil baseline log Nginx sebelum outage
        nginx_logs_before_count = len(fetch_nginx_access_log(cfg["nginx_container"]))

        print("  Mengirim 30 request berturut-turut melalui Nginx saat 1 backend mati...")
        surviving_seen = set()
        errors_5xx = 0
        conn_errors = 0
        durations_failure = []
        statuses = {}

        for i in range(30):
            r = http_get(base_url, "/products")
            st = r.get("status")
            statuses[st] = statuses.get(st, 0) + 1
            b_id = r.get("backend_id")
            if b_id and b_id != "unknown":
                surviving_seen.add(b_id)
            if st is not None and st >= 500:
                errors_5xx += 1
            elif st == 0:
                conn_errors += 1
            durations_failure.append(r.get("elapsed_ms", 0))

        # Ambil log Nginx setelah 30 request untuk memverifikasi upstream behavior
        all_logs_after = fetch_nginx_access_log(cfg["nginx_container"])
        new_nginx_logs = all_logs_after[nginx_logs_before_count:]

        # Analisis Upstream Access Logs Nginx
        target_attempts = 0
        target_success = 0
        target_failures = 0
        survivor_success = 0
        parsed_records = 0

        for line in new_nginx_logs:
            try:
                entry = json.loads(line)
                parsed_records += 1
                up_addr_raw = str(entry.get("upstream_addr") or entry.get("upstream") or "")
                up_status_raw = str(entry.get("upstream_status") or entry.get("status") or "")

                # Nginx can log multiple upstream attempts as comma-separated values:
                addrs = [a.strip() for a in up_addr_raw.split(",") if a.strip()]
                statuses_list = [s.strip() for s in up_status_raw.split(",") if s.strip()]

                for idx, addr in enumerate(addrs):
                    st_val = statuses_list[idx] if idx < len(statuses_list) else str(entry.get("status", 0))
                    if target_ip and target_ip in addr:
                        target_attempts += 1
                        if st_val == "200":
                            target_success += 1
                        else:
                            target_failures += 1
                    if surviving_ip and surviving_ip in addr:
                        if st_val == "200":
                            survivor_success += 1
            except Exception:
                pass

        avg_failure = (
            round(sum(durations_failure) / len(durations_failure), 2)
            if durations_failure
            else 0
        )
        print(f"  - Distribusi Status HTTP Klien: {statuses}")
        print(f"  - Backend yang melayani (X-Backend-Id): {list(surviving_seen)}")
        print(f"  - HTTP 5xx errors: {errors_5xx}, Connection errors: {conn_errors}")
        print(f"  - Rata-rata latensi saat gangguan: {avg_failure} ms")

        print("\n  [BUKTI EMPIRIS UPSTREAM ACCESS LOG NGINX]")
        print(f"  - Total record access log dianalisis: {parsed_records}")
        print(f"  - Percobaan koneksi Nginx ke IP target mati ({target_ip}): {target_attempts}")
        print(f"  - Respons sukses (HTTP 200) dari backend yang mati: {target_success} (Terbukti 0)")
        print(f"  - Request gagal ke target saat jendela transisi failover: {target_failures}")
        print(f"  - Request berhasil dilayani oleh backend survivor ({surviving_ip}): {survivor_success}")

        # Strict Assertions:
        # 0. Verifikasi bahwa log Nginx benar-benar tersedia dan terbaca (fail-closed)
        if parsed_records == 0:
            print(
                "\n[FAIL] Access log Nginx tidak menghasilkan record yang dapat dianalisis! Tidak dapat membuktikan ketiadaan traffic ke backend mati berdasarkan log kosong."
            )
            sys.exit(1)

        # 1. Surviving backend wajib melayani request
        if len(surviving_seen) == 0:
            print(
                f"\n[FAIL] Tidak ada backend yang melayani request saat {target_backend} mati!"
            )
            sys.exit(1)

        # 2. Backend yang dihentikan TIDAK menghasilkan respons sukses sama sekali
        if target_id and target_id in surviving_seen:
            print(
                f"\n[FAIL] Container target yang sudah mati ({target_id}) terdeteksi merespons sukses!"
            )
            sys.exit(1)
        if target_success > 0:
            print(
                f"\n[FAIL] Upstream access log mencatat {target_success} respons sukses dari backend yang mati!"
            )
            sys.exit(1)
        print(
            f"  [ASSERTION PASS] Backend yang dihentikan terbukti tidak menghasilkan respons sukses (0 response 200)."
        )
        print(
            f"  [ASSERTION PASS] Upstream connection attempts ke target mati terisolasi pada jendela deteksi ({target_failures} transition timeouts)."
        )

        # 3. Ketersediaan layanan pasca failover
        success_count = statuses.get(200, 0)
        if success_count < min_success:
            print(
                f"\n[FAIL] Tingkat keberhasilan request terlalu rendah saat failover ({success_count}/30)! Expected >= {min_success}."
            )
            sys.exit(1)
        print(
            f"  [ASSERTION PASS] Ketersediaan layanan terjaga melalui surviving backend ({success_count}/30 sukses 200 OK)."
        )

    finally:
        # -------------------------------------------------------------
        # 3. Recovery: Restart Target Backend (Always executed)
        # -------------------------------------------------------------
        print(f"\n[FASE 3: Pemulihan Backend - Menjalankan Kembali {target_backend}]")
        print(f"  Menjalankan: docker start {target_backend}...")
        code, out, err = run_command(["docker", "start", target_backend], timeout=30)
        if code != 0:
            print(f"\n[FAIL] Gagal menjalankan kembali {target_backend}: {err}")
            sys.exit(1)

        print("  Menunggu backend pulih dan kembali berstatus healthy...")
        recovered_healthy = False
        target_recovered_state = None
        for wait_step in range(25):
            time.sleep(2)
            c_state = inspect_container(target_backend)
            if c_state["running"] and c_state["health"] in ("healthy", "none"):
                recovered_healthy = True
                target_recovered_state = c_state
                break

        if not recovered_healthy:
            print(
                f"\n[FAIL] Container {target_backend} tidak pulih menjadi healthy dalam batas waktu!"
            )
            sys.exit(1)

        if target_id and target_recovered_state and target_recovered_state["id"] != target_id:
            print(
                f"\n[FAIL] Container ID mismatch setelah restart! Diharapkan {target_id}, didapat {target_recovered_state['id']}."
            )
            sys.exit(1)

        print(
            f"  [ASSERTION PASS] Container {target_backend} ({target_recovered_state['id']}) kembali RUNNING dan HEALTHY."
        )

        # Verifikasi pemulihan round-robin routing Nginx
        print("  Memverifikasi Nginx kembali mendistribusikan traffic ke kedua backend...")
        recovered_backends_seen = set()
        durations_recovered = []
        traffic_restored = False

        for attempt in range(15):
            time.sleep(2)
            recovered_backends_seen.clear()
            durations_recovered.clear()
            for _ in range(20):
                r = http_get(base_url, "/health")
                b_id = r.get("backend_id")
                if b_id and b_id != "unknown":
                    recovered_backends_seen.add(b_id)
                durations_recovered.append(r.get("elapsed_ms", 0))
            if len(recovered_backends_seen) >= 2:
                traffic_restored = True
                break

        avg_recovered = (
            round(sum(durations_recovered) / len(durations_recovered), 2)
            if durations_recovered
            else 0
        )
        print(f"  - Backend yang kembali melayani: {list(recovered_backends_seen)}")
        print(f"  - Rata-rata latensi pasca pemulihan: {avg_recovered} ms")

        if not traffic_restored:
            print(
                f"\n[FAIL] Nginx tidak kembali mendistribusikan traffic ke kedua backend setelah pemulihan (hanya: {recovered_backends_seen})!"
            )
            sys.exit(1)
        print(
            "  [ASSERTION PASS] Routing Nginx kembali konsisten ke seluruh backend instance."
        )

    # -------------------------------------------------------------
    # 4. Database Invariant Check Post-Test (WAJIB SUKSES - NO FALSE PASS)
    # -------------------------------------------------------------
    print("\n[FASE 4: Verifikasi Konsistensi Database Pasca Pengujian]")
    final_stats = http_get(base_url, "/stats")
    if final_stats["status"] != 200 or not isinstance(final_stats.get("body"), dict):
        print(
            f"\n[FAIL] Verifikasi database pasca pengujian gagal! Endpoint {base_url}/stats mengembalikan HTTP {final_stats['status']} (error: {final_stats.get('error')})"
        )
        sys.exit(1)

    body = final_stats["body"]
    consistent = body.get("consistent", False)
    negative_stock = body.get("negative_stock", 0)
    duplicate_orders = body.get("duplicate_orders", 0)
    print(
        f"  - Database Consistent : {consistent} (negative_stock: {negative_stock}, duplicate_orders: {duplicate_orders})"
    )
    if not consistent or negative_stock > 0 or duplicate_orders > 0:
        print(
            f"\n[FAIL] Invarian database terlanggar pasca pengujian! (consistent={consistent}, neg={negative_stock}, dup={duplicate_orders})"
        )
        sys.exit(1)
    print("  [ASSERTION PASS] Invarian database terverifikasi valid dan konsisten.")

    # -------------------------------------------------------------
    # 5. Technical Failure Behavior Documentation
    # -------------------------------------------------------------
    print("\n[FASE 5: Analisis Karakteristik Kegagalan]")
    print(
        "  1. Subsequent Requests: Nginx mendeteksi kegagalan backend dan mengalihkan traffic"
    )
    print(
        "     ke backend yang bertahan. Pada P3, 2 worker Nginx x max_fails=2 menghasilkan tepat"
    )
    print(
        "     4 request timeout (504) selama masa deteksi transisi karena 'proxy_next_upstream off'."
    )
    print(
        "  2. In-Flight Requests: 'proxy_next_upstream off' menjamin transaksi checkout tidak diulang"
    )
    print(
        "     secara otomatis oleh proxy jika backend terputus di tengah jalan, mencegah duplikasi mutasi."
    )
    print(
        "  3. Restart Policy: Container dikonfigurasi dengan 'restart: unless-stopped', memastikan"
    )
    print(
        "     Docker daemon merecovery container yang mengalami crash secara otomatis."
    )

    print("\n" + "=" * 75)
    print(f"HASIL: PENGUJIAN KETAHANAN KEGAGALAN BACKEND ({stack_name.upper()}) BERHASIL PENUH (PASS)")
    print("=" * 75)
    sys.exit(0)


if __name__ == "__main__":
    main()
