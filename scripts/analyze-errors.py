import gzip
import json
import glob
import os
import sys
from datetime import datetime

def parse_iso(s):
    if not s:
        return None
    # Handle ISO string e.g. 2026-10-31T10:38:32.4571033+07:00
    # Python 3.11+ fromisoformat handles +07:00 and fractional seconds
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
    meas_start_s = manifest.get('measurement_start_seconds', 0)
    
    # We will compute:
    # 1. first error
    # 2. totals (attempts, success, infra_errors, http_5xx, timeouts, conn_errors)
    # 3. second-by-second buckets for error rate & latency p95
    # 4. correlate with metrics.ndjson at first error
    
    first_error = None
    first_req_t = None
    meas_start_t = None
    
    counts = {
        'attempts': 0,
        'success': 0,
        'infra_errors': 0,
        'http_5xx': 0,
        'timeouts': 0,
        'conn_errors': 0,
        'status_0_reasons': {}
    }
    
    # Per-second buckets
    # key: second offset from start of measurement
    sec_buckets = {} # int_sec -> {'attempts': 0, 'errors': 0, 'durations': []}
    
    is_gz = gz_file.endswith('.gz')
    open_fn = gzip.open(gz_file, 'rt', encoding='utf-8', errors='ignore') if is_gz else open(gz_file, 'r', encoding='utf-8', errors='ignore')
    
    with open_fn as f:
        for line in f:
            if not line.strip():
                continue
            # Fast check: only parse Points of interest
            # We want http_reqs (for status & error) and http_req_duration (for latency)
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
                    if status.isdigit() and int(status) >= 500:
                        counts['http_5xx'] += 1
                    elif err_code == '1050' or 'timeout' in err.lower():
                        counts['timeouts'] += 1
                    else:
                        counts['conn_errors'] += 1
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
                # Track duration for p95
                if meas_start_t:
                    ev = json.loads(line)
                    d = ev.get('data', {})
                    t = parse_iso(d.get('time'))
                    if t and t >= meas_start_t:
                        rel_s = int((t - meas_start_t).total_seconds())
                        val = d.get('value', 0)
                        b = sec_buckets.setdefault(rel_s, {'attempts': 0, 'errors': 0, 'durations': []})
                        b['durations'].append(val)

    # Compute p95 and degradation point
    # Find second where p95 jumps above 500ms or 1000ms
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

    # Check metrics.ndjson at first error timestamp
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

    # Autoscaling events in this run
    events = []
    events_file = os.path.join(run_dir, 'scaling-events.ndjson')
    if os.path.exists(events_file):
        with open(events_file, 'r', encoding='utf-8') as ef:
            for line in ef:
                if line.strip():
                    events.append(json.loads(line))

    return {
        'id': manifest.get('id'),
        'campaign': os.path.basename(campaign_dir),
        'mode': manifest.get('mode'),
        'vus': manifest.get('vus'),
        'duration_s': manifest.get('measurement_seconds'),
        'counts': counts,
        'error_rate_pct': round((counts['infra_errors'] / max(counts['attempts'], 1)) * 100, 2),
        'first_error': first_error,
        'p95_degradation_sec': p95_degradation_sec,
        'metrics_at_first_error': metrics_at_error,
        'scaling_events_count': len(events),
        'scaling_events': events
    }

if __name__ == '__main__':
    campaigns = sorted(glob.glob('results/p3/*-stress'))
    results = []
    for c in campaigns:
        sys.stderr.write(f'Analyzing {os.path.basename(c)}...\n')
        sys.stderr.flush()
        res = analyze_campaign(c)
        if res:
            results.append(res)
    
    print(json.dumps(results, indent=2))
