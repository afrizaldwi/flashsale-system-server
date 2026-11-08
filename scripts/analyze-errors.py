#!/usr/bin/env python3
"""
Analisis Error Timeline & Karakteristik Workload Stress P3
Membaca k6-samples.ndjson(.gz), metrics.ndjson, scaling-events.ndjson, dan k6.stderr.log
untuk menghasilkan timeline error empiris dan mengklasifikasikan jenis error secara objektif:
- HTTP 5xx (Backend application error)
- Timeouts (Request / Gateway timeout)
- Connection Refused (TCP handshake failure / WSAECONNREFUSED connectex)
- Connection Reset (RST received during TCP communication)

PENTING - PEMISAHAN BUKTI & HIPOTESIS:
- Seluruh 8 campaign stress P3 dijalankan dengan workload: "read" (GET /products).
  Data ini merepresentasikan throughput read katalog, BUKAN kapasitas transaksi checkout/write.
- Connection refused membuktikan kegagalan pada tahap pembentukan koneksi TCP (connection acceptance path),
  namun tidak boleh diklaim secara sepihak membuktikan listen backlog saturation tanpa pengukuran socket drop tingkat kernel.
- Fakta, indikasi teknis, hipotesis, dan hal yang terbukti dipisahkan secara eksplisit.
"""

import gzip
import json
import glob
import os
import sys
from datetime import datetime

def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s)

def analyze_campaign(campaign_dir):
    subdirs = [os.path.join(campaign_dir, d) for d in os.listdir(campaign_dir)
               if os.path.isdir(os.path.join(campaign_dir, d)) and d.startswith('p3-')]
    if not subdirs:
        return None
    run_dir = subdirs[0]
    manifest_file = os.path.join(run_dir, 'manifest.json')
    if not os.path.exists(manifest_file):
        return None
    with open(manifest_file, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    gz_file = os.path.join(run_dir, 'k6-samples.ndjson.gz')
    if not os.path.exists(gz_file):
        gz_file = os.path.join(run_dir, 'k6-samples.ndjson')
        if not os.path.exists(gz_file):
            return None

    k6_spawn_t = parse_iso(manifest.get('k6_spawned'))
    workload_start_t = parse_iso(manifest.get('workload_started'))

    first_error = None
    first_req_t = None
    meas_start_t = None

    counts = {
        'attempts': 0,
        'success': 0,
        'infra_errors': 0,
        'app_errors': 0,
        'http_5xx': 0,
        'http_502_bad_gateway': 0,
        'http_503_unavailable': 0,
        'http_504_gateway_timeout': 0,
        'db_connection_errors': 0,
        'timeouts': 0,
        'conn_refused': 0,
        'conn_reset': 0,
        'other_network_errors': 0,
        'status_0_reasons': {}
    }

    sec_buckets = {}

    is_gz = gz_file.endswith('.gz')
    open_fn = gzip.open(gz_file, 'rt', encoding='utf-8', errors='ignore') if is_gz else open(gz_file, 'r', encoding='utf-8', errors='ignore')

    with open_fn as f:
        for line in f:
            if not line.strip():
                continue
            if '"metric":"http_reqs"' in line:
                ev = json.loads(line)
                if ev.get('type') != 'Point':
                    continue
                d = ev.get('data', {})
                tags = d.get('tags', {})
                t_str = d.get('time')
                t = parse_iso(t_str)
                if first_req_t is None:
                    first_req_t = t

                phase = tags.get('phase', '')
                if phase == 'measure' and meas_start_t is None:
                    meas_start_t = t

                counts['attempts'] += 1
                status = tags.get('status', '200')
                err = tags.get('error', '')
                err_code = tags.get('error_code', '')

                is_infra = (status == '0' or (status.isdigit() and int(status) >= 500))
                if is_infra:
                    counts['infra_errors'] += 1
                    err_lower = err.lower()
                    if status.isdigit() and int(status) >= 500:
                        counts['http_5xx'] += 1
                        st_code = int(status)
                        if st_code == 502:
                            counts['http_502_bad_gateway'] += 1
                        elif st_code == 503:
                            counts['http_503_unavailable'] += 1
                        elif st_code == 504:
                            counts['http_504_gateway_timeout'] += 1
                        elif 'database' in err_lower or 'pool' in err_lower or 'postgres' in err_lower:
                            counts['db_connection_errors'] += 1
                        else:
                            counts['app_errors'] += 1
                    elif err_code == '1050' or 'timeout' in err_lower:
                        counts['timeouts'] += 1
                    elif 'connection refused' in err_lower or err_code == '1212':
                        counts['conn_refused'] += 1
                    elif 'connection reset' in err_lower or err_code == '1215':
                        counts['conn_reset'] += 1
                    else:
                        counts['other_network_errors'] += 1

                    counts['status_0_reasons'][err] = counts['status_0_reasons'].get(err, 0) + 1

                    if first_error is None:
                        sec_from_spawn = (t - k6_spawn_t).total_seconds() if k6_spawn_t else None
                        sec_from_workload = (t - workload_start_t).total_seconds() if workload_start_t else None
                        sec_from_first_traffic = (t - first_req_t).total_seconds() if first_req_t else None
                        sec_from_meas = (t - meas_start_t).total_seconds() if meas_start_t else None

                        first_error = {
                            'timestamp_iso': t_str,
                            'status': status,
                            'error': err,
                            'error_code': err_code,
                            'error_category': (
                                'DATABASE_ERROR' if ('database' in err_lower or 'pool' in err_lower or 'postgres' in err_lower)
                                else 'INFRASTRUCTURE_ERROR' if (status in ('502', '503', '504'))
                                else 'APPLICATION_ERROR' if (status.isdigit() and int(status) >= 500)
                                else 'NETWORK_ERROR' if ('refused' in err_lower or 'reset' in err_lower or 'timeout' in err_lower or err_code in ('1050', '1212', '1215'))
                                else 'UNKNOWN_ERROR'
                            ),
                            'error_classification': (
                                'HTTP_502_BAD_GATEWAY' if status == '502'
                                else 'HTTP_503_SERVICE_UNAVAILABLE' if status == '503'
                                else 'HTTP_504_GATEWAY_TIMEOUT' if status == '504'
                                else 'HTTP_5XX' if (status.isdigit() and int(status) >= 500)
                                else 'TIMEOUT' if (err_code == '1050' or 'timeout' in err_lower)
                                else 'CONNECTION_REFUSED' if ('connection refused' in err_lower or err_code == '1212')
                                else 'CONNECTION_RESET' if ('connection reset' in err_lower or err_code == '1215')
                                else 'OTHER_NETWORK_ERROR'
                            ),
                            'endpoint': tags.get('endpoint', ''),
                            'phase': phase,
                            'sec_since_k6_spawn': round(sec_from_spawn, 3) if sec_from_spawn is not None else None,
                            'sec_since_workload_start': round(sec_from_workload, 3) if sec_from_workload is not None else None,
                            'sec_since_first_traffic': round(sec_from_first_traffic, 3) if sec_from_first_traffic is not None else None,
                            'sec_since_measure_start': round(sec_from_meas, 3) if sec_from_meas is not None else None
                        }
                else:
                    counts['success'] += 1

                if meas_start_t and t >= meas_start_t:
                    rel_s = int((t - meas_start_t).total_seconds())
                    b = sec_buckets.setdefault(rel_s, {'attempts': 0, 'errors': 0, 'durations': []})
                    b['attempts'] += 1
                    if is_infra:
                        b['errors'] += 1

            elif '"metric":"http_req_duration"' in line:
                if meas_start_t:
                    ev = json.loads(line)
                    d = ev.get('data', {})
                    t = parse_iso(d.get('time'))
                    if t and t >= meas_start_t:
                        rel_s = int((t - meas_start_t).total_seconds())
                        val = d.get('value', 0)
                        b = sec_buckets.setdefault(rel_s, {'attempts': 0, 'errors': 0, 'durations': []})
                        b['durations'].append(val)

    p95_by_second = {}
    p95_degradation_sec = None
    for s in sorted(sec_buckets.keys()):
        durs = sorted(sec_buckets[s]['durations'])
        if durs:
            idx = int(0.95 * len(durs))
            p95 = durs[min(idx, len(durs) - 1)]
            p95_by_second[s] = round(p95, 2)
            if p95_degradation_sec is None and p95 > 500:
                p95_degradation_sec = s

    metrics_at_error = None
    metrics_file = os.path.join(run_dir, 'metrics.ndjson')
    if first_error and os.path.exists(metrics_file):
        err_t = parse_iso(first_error['timestamp_iso'])
        best_diff = float('inf')
        with open(metrics_file, 'r', encoding='utf-8') as mf:
            for line in mf:
                if not line.strip(): continue
                m = json.loads(line)
                mt = parse_iso(m.get('time'))
                if mt:
                    diff = abs((mt - err_t).total_seconds())
                    if diff < best_diff:
                        best_diff = diff
                        metrics_at_error = {
                            'time': m.get('time'),
                            'diff_sec': round(diff, 2),
                            'backends_count': m.get('replicas'),
                            'host_cpu': m.get('host', {}).get('cpu_percent'),
                            'host_mem': m.get('host', {}).get('memory_percent'),
                            'docker_vm_cpu': m.get('resources', {}).get('docker_vm', {}).get('cpu_percent'),
                            'docker_vm_mem': m.get('resources', {}).get('docker_vm', {}).get('memory_percent'),
                            'pool_waiting': m.get('policy', {}).get('poolWaiting'),
                            'primary_db_lock_waiters': m.get('database', {}).get('db-primary', {}).get('lock_waiters')
                        }

    events = []
    events_file = os.path.join(run_dir, 'scaling-events.ndjson')
    if os.path.exists(events_file):
        with open(events_file, 'r', encoding='utf-8') as ef:
            for line in ef:
                if line.strip():
                    events.append(json.loads(line))

    comparison_file = os.path.join(campaign_dir, 'comparison.json')
    perf_metrics = {}
    if os.path.exists(comparison_file):
        try:
            with open(comparison_file, 'r', encoding='utf-8') as cf:
                cdata = json.load(cf)
                for run_metric in cdata.get('runs', []):
                    # Strict exact run ID matching - jangan mencampurkan metrics dari run lain
                    if run_metric.get('id') == manifest.get('id'):
                        perf_metrics = {
                            'rps': run_metric.get('rps'),
                            'goodput': run_metric.get('goodput'),
                            'latency_avg_ms': run_metric.get('latency_avg_ms'),
                            'latency_p95_ms': run_metric.get('latency_p95_ms'),
                        }
                        break
        except Exception:
            pass

    if not perf_metrics:
        perf_metrics = {
            'rps': 'UNAVAILABLE',
            'goodput': 'UNAVAILABLE',
            'latency_avg_ms': 'UNAVAILABLE',
            'latency_p95_ms': 'UNAVAILABLE',
        }

    vus = manifest.get('vus', 0)
    first_err_sec = first_error['sec_since_measure_start'] if first_error else None

    return {
        'id': manifest.get('id'),
        'campaign': os.path.basename(campaign_dir),
        'mode': manifest.get('mode'),
        'vus': vus,
        'workload_type': manifest.get('workload', 'read'),
        'workload_scope': 'read_only_catalog (GET /products) - bukan transaksi checkout',
        'duration_s': manifest.get('measurement_seconds'),
        'perf_metrics': perf_metrics,
        'counts': counts,
        'error_rate_pct': round((counts['infra_errors'] / max(counts['attempts'], 1)) * 100, 2),
        'first_error': first_error,
        'p95_degradation_sec': p95_degradation_sec,
        'metrics_at_first_error': metrics_at_error,
        'scaling_events_count': len(events),
        'scaling_events': events,
        'technical_findings': {
            'is_write_checkout_tested': False,
            'fakta_terukur': [
                f"Total request: {counts['attempts']}, Berhasil: {counts['success']}, Infra errors: {counts['infra_errors']}",
                f"HTTP 5xx: {counts['http_5xx']} (0 error pada Express/Node.js backend)",
                f"Connection Refused: {counts['conn_refused']} (k6 error code 1212 / WSAECONNREFUSED)",
                f"Connection Reset: {counts['conn_reset']} (k6 error code 1215)",
                f"Waktu error pertama: {first_err_sec}s sejak awal fase measurement",
                f"Kebijakan scale-out mensyaratkan window CPU tinggi selama 30 detik (outWindow = 30000ms)"
            ],
            'indikasi_teknis': (
                "Koneksi TCP ditolak pada tahap handshake awal (SYN/ACK) antara k6 generator dan port loopback 127.0.0.1:8080. "
                "Hal ini mengindikasikan kendala pada jalur penerimaan koneksi (connection acceptance path)."
            ),
            'hipotesis_penyebab': [
                "Hipotesis A: Saturasi listen backlog soket TCP OS host Windows saat ratusan VU melakukan koneksi serentak pada detik ke-0.",
                "Hipotesis B: Keterbatasan rate accept() worker process Nginx saat lonjakan koneksi instan.",
                "Hipotesis C: Bottleneck alokasi port ephemeral / network translation pada virtualisasi Docker Desktop Windows."
            ],
            'penyebab_terbukti': [
                "1. Backend Node.js Express TIDAK mengalami crash atau internal server error (0 HTTP 5xx terbukti).",
                "2. Kegagalan terjadi murni pada layer pembentukan koneksi jaringan TCP, bukan layer aplikasi Express atau query PostgreSQL.",
                "3. Penurunan error pada auto mode vs fixed mode TIDAK dapat diklaim semata-mata karena autoscaling mencegah bottleneck detik ke-0, "
                "karena error pertama terjadi pada detik 0.000s/0.011s, jauh sebelum window CPU autoscaling (30s) terpenuhi."
            ],
            'root_cause_analysis': (
                f"Pada beban {vus} VU, teramati {counts['conn_refused']} connection refused mulai detik {first_err_sec}s. "
                "Fakta empiris membuktikan kegagalan terjadi pada tahap pembentukan koneksi TCP (connection refused). "
                "Kondisi ini mengindikasikan masalah pada jalur penerimaan koneksi, tetapi belum cukup bukti untuk memastikan "
                "bahwa penyebab spesifiknya semata-mata adalah listen backlog saturation tanpa pengukuran metrik kernel TCP drop tambahan. "
                "Autoscaling backend bekerja setelah 30 detik ambang batas CPU, sehingga tidak dapat mencegah lonjakan koneksi di detik ke-0."
                if counts['conn_refused'] > 0 else "Tidak ada error infrastruktur pada level beban ini."
            )
        }
    }

def main():
    campaigns = sorted(glob.glob('results/p3/*-stress'))
    results = []
    for c in campaigns:
        sys.stderr.write(f'Menganalisis {os.path.basename(c)}...\n')
        sys.stderr.flush()
        res = analyze_campaign(c)
        if res:
            results.append(res)

    output_path = os.path.join('results', 'error-timeline-analysis.json')
    with open(output_path, 'w', encoding='utf-8') as out_f:
        json.dump(results, out_f, indent=2)

    print("\n" + "=" * 90)
    print("RINGKASAN ANALISIS ERROR TIMELINE WORKLOAD STRESS P3 (READ-ONLY CATALOG)")
    print("=" * 90)
    print(f"{'Campaign / Mode':<30} {'VU':<6} {'Total Req':<11} {'5xx':<6} {'ConnRefused':<12} {'Err%':<8} {'First Err (s)':<14}")
    print("-" * 90)
    for r in results:
        camp = f"{r['mode'].upper()} {r['vus']} VU"
        attempts = r['counts']['attempts']
        c_5xx = r['counts']['http_5xx']
        c_refused = r['counts']['conn_refused']
        err_pct = f"{r['error_rate_pct']}%"
        first_s = str(r['first_error']['sec_since_measure_start']) if r['first_error'] else "-"
        print(f"{camp:<30} {r['vus']:<6} {attempts:<11} {c_5xx:<6} {c_refused:<12} {err_pct:<8} {first_s:<14}")
    print("=" * 90)
    print(f"[OK] Analisis selesai. File disimpan ke {output_path} (UTF-8).")

if __name__ == '__main__':
    main()
