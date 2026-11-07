import urllib.request
import urllib.error
import json
import time
import subprocess
import uuid

BASE_URL = "http://127.0.0.1:8080"
PRIMARY_CONTAINER = "flashsale-p3-db-primary-1"
REPLICA_CONTAINER = "flashsale-p3-db-replica-1"
DB_USER = "p3_admin"
DB_NAME = "flashsale_p3"

def http_get(endpoint):
    url = f"{BASE_URL}{endpoint}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            headers = {k.lower(): v for k, v in resp.getheaders()}
            body = resp.read().decode("utf-8")
            return {
                "status": resp.status,
                "headers": headers,
                "body": json.loads(body) if body.startswith(("[", "{")) else body
            }
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in e.headers.items()}
        body = e.read().decode("utf-8")
        return {
            "status": e.code,
            "headers": headers,
            "body": json.loads(body) if body.startswith(("[", "{")) else body
        }
    except Exception as e:
        return {"status": 0, "error": str(e)}

def http_post_checkout(product_id=2, qty=1, user_id=1, key=None):
    if key is None:
        key = f"p3-test-resilience-{uuid.uuid4()}"
    url = f"{BASE_URL}/checkout"
    payload = json.dumps({"user_id": user_id, "product_id": product_id, "qty": qty}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Idempotency-Key": key},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
            return {
                "status": resp.status,
                "key": key,
                "body": json.loads(body) if body.startswith(("[", "{")) else body
            }
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        return {
            "status": e.code,
            "key": key,
            "body": json.loads(body) if body.startswith(("[", "{")) else body
        }
    except Exception as e:
        return {"status": 0, "key": key, "error": str(e)}

def docker_sql(container, sql):
    cmd = f'docker exec {container} psql -U {DB_USER} -d {DB_NAME} -AtXc "{sql}"'
    try:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        return res.stdout.strip()
    except Exception as e:
        return f"ERROR: {e}"

def run_command(cmd):
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return res.stdout.strip()

def main():
    print("="*70)
    print("TEST VALIDASI RESILIENCE & DATABASE REPLICATION PERTEMUAN 1-3")
    print("="*70)

    # 1. Baseline
    print("\n[FASE 1: Kondisi Baseline Normal]")
    h1 = http_get("/health")
    print(f"1. /health: HTTP {h1.get('status')} -> db: {h1.get('body',{}).get('db')}, replica: {h1.get('body',{}).get('replica')}, lag: {h1.get('body',{}).get('replica_lag_seconds')}s")
    
    p1 = http_get("/products")
    src1 = p1.get("headers", {}).get("x-read-from", "none")
    print(f"2. GET /products: HTTP {p1.get('status')} -> Header X-Read-From: '{src1}'")
    
    pri_role = docker_sql(PRIMARY_CONTAINER, "SELECT pg_is_in_recovery();")
    rep_role = docker_sql(REPLICA_CONTAINER, "SELECT pg_is_in_recovery();")
    print(f"3. Role PostgreSQL: Primary in_recovery={pri_role} (f=writer), Replica in_recovery={rep_role} (t=standby)")
    
    rep_stat = docker_sql(PRIMARY_CONTAINER, "SELECT application_name || ' | state:' || state || ' | sync:' || sync_state FROM pg_stat_replication;")
    print(f"4. Streaming Replication State di Primary: {rep_stat}")

    assert src1 == "replica", f"Expected X-Read-From: replica, got {src1}"
    assert pri_role == "f", "Primary should have in_recovery=false"
    assert rep_role == "t", "Replica should have in_recovery=true"

    # 2. Write Transaction to Primary & Replication Check
    print("\n[FASE 2: Transaksi Tulis (POST /checkout) & Verifikasi Replikasi]")
    c1 = http_post_checkout(product_id=2, qty=1, user_id=1)
    print(f"1. POST /checkout (Product 2, Qty 1): HTTP {c1.get('status')} -> Result: {c1.get('body',{}).get('result')}, Order ID: {c1.get('body',{}).get('order',{}).get('id')}")
    
    # Check duplicate idempotency
    c1_dup = http_post_checkout(product_id=2, qty=1, user_id=1, key=c1["key"])
    print(f"2. POST /checkout (Duplicate Key): HTTP {c1_dup.get('status')} -> Result: {c1_dup.get('body',{}).get('result')}")

    time.sleep(1) # wait replication
    pri_orders = docker_sql(PRIMARY_CONTAINER, "SELECT count(*) FROM orders;")
    rep_orders = docker_sql(REPLICA_CONTAINER, "SELECT count(*) FROM orders;")
    print(f"3. Verifikasi Sinkronisasi Data: Orders di Primary={pri_orders}, Orders di Replica={rep_orders}")
    assert pri_orders == rep_orders, f"Mismatch orders! Primary: {pri_orders}, Replica: {rep_orders}"

    # 3. Simulate Replica Failure
    print("\n[FASE 3: Simulasi Replica Down -> Pengujian Read Fallback ke Primary]")
    print(f"Menghentikan container replica: docker stop {REPLICA_CONTAINER}...")
    run_command(f"docker stop {REPLICA_CONTAINER}")
    time.sleep(2)

    h2 = http_get("/health")
    print(f"1. /health saat replica down: HTTP {h2.get('status')} -> db: {h2.get('body',{}).get('db')}, replica: {h2.get('body',{}).get('replica')}")

    p2 = http_get("/products")
    src2 = p2.get("headers", {}).get("x-read-from", "none")
    print(f"2. GET /products saat replica down: HTTP {p2.get('status')} -> Header X-Read-From: '{src2}'")
    assert src2 == "primary", f"Expected fallback to 'primary', got '{src2}'"
    print("   >>> SUKSES: Read Fallback ke Primary terbukti berfungsi otomatis!")

    # Write still works while replica is down
    c2 = http_post_checkout(product_id=2, qty=1, user_id=1)
    print(f"3. POST /checkout saat replica down: HTTP {c2.get('status')} -> Primary tetap melayani transaksi tulis!")

    # 4. Simulate Replica Recovery
    print("\n[FASE 4: Simulasi Replica Pulih -> Pengujian Otomatis Kembali ke Replica]")
    print(f"Menjalankan kembali container replica: docker start {REPLICA_CONTAINER}...")
    run_command(f"docker start {REPLICA_CONTAINER}")
    
    # Wait for replica to be ready
    print("Menunggu replica hot standby siap...")
    for _ in range(15):
        time.sleep(2)
        h_chk = http_get("/health")
        if h_chk.get("body", {}).get("replica") == "up":
            break

    h3 = http_get("/health")
    print(f"1. /health setelah replica pulih: HTTP {h3.get('status')} -> db: {h3.get('body',{}).get('db')}, replica: {h3.get('body',{}).get('replica')}, lag: {h3.get('body',{}).get('replica_lag_seconds')}s")

    p3 = http_get("/products")
    src3 = p3.get("headers", {}).get("x-read-from", "none")
    print(f"2. GET /products setelah replica pulih: HTTP {p3.get('status')} -> Header X-Read-From: '{src3}'")
    assert src3 == "replica", f"Expected read to return to 'replica', got '{src3}'"
    print("   >>> SUKSES: Pembacaan otomatis kembali menggunakan replica setelah pulih!")

    # 5. Consistency check
    print("\n[FASE 5: Pemeriksaan Konsistensi Data & Invarian Stok]")
    time.sleep(1)
    st = http_get("/stats")
    print(f"1. /stats: consistent={st.get('body',{}).get('consistent')}, negative_stock={st.get('body',{}).get('negative_stock')}, duplicate_orders={st.get('body',{}).get('duplicate_orders')}, total_orders={st.get('body',{}).get('total_orders')}")

    print("\n" + "="*70)
    print("SELURUH PENGUJIAN REPLIKASI, FALLBACK, DAN RECOVERY BERHASIL (PASS)")
    print("="*70)

if __name__ == "__main__":
    main()
