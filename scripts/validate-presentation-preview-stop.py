"""Linux installed-host SIGTERM probe, run as the Reader service account."""
import json
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time

executable, output = sys.argv[1:]
output = pathlib.Path(output)
output.mkdir(parents=True, exist_ok=True)
temporary = pathlib.Path(tempfile.gettempdir())
before = set(temporary.glob("understand-book-preview-*"))
request = {
    "candidate_id": "rp1-host-stop",
    "html": "<body><script>while(true){}</script></body>",
    "actions": [],
}
start = time.monotonic()
process = subprocess.Popen(
    [executable, "--presentation-preview-probe"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
timer = threading.Timer(2, process.send_signal, args=(signal.SIGTERM,))
timer.start()
try:
    stdout, stderr = process.communicate(json.dumps(request), timeout=12)
finally:
    timer.cancel()
    if process.poll() is None:
        process.kill()
        process.wait()
result = json.loads(stdout)
assert process.returncode == 1, (process.returncode, result, stderr)
assert result["candidate_id"] == request["candidate_id"]
assert result["message"] == "AGENT_RUN_CANCELLED", result
assert result["phase"] != "launch", result
assert not (set(temporary.glob("understand-book-preview-*")) - before), "profile leaked"
processes = subprocess.check_output(["ps", "-eo", "pid,args"], text=True)
remaining = [line for line in processes.splitlines()
             if "--user-data-dir=" in line and "understand-book-preview-" in line]
assert not remaining, remaining
report = {
    "status": "passed", "signal": "SIGTERM", "elapsed_ms": round((time.monotonic() - start) * 1000),
    "exit_code": process.returncode, "remaining_preview_processes": remaining,
    "temporary_profiles_cleaned": True, "result": result,
}
(output / "host-stop.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
