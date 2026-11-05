#!/usr/bin/env python3
"""Isolated Docker+age smoke with dummy credentials and a test-only Bybit transport.
Never uses live BBB data or real exchange keys. Does not deploy the main stack.
"""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "abi:authorization-root-review"
NAME = "abi-authorization-delivery-smoke"
# Public dummy test material. Never a real API credential or operator password.
PAIR = b'["smoke-key","smoke-secret"]'
PASSPHRASE = b"known-test-passphrase-only\n"


def command(*args, input=None):
    return subprocess.check_output(args, input=input, stderr=subprocess.PIPE)


def terminal(operation, expected_success=True, passphrase=PASSPHRASE):
    pid, descriptor = pty.fork()
    if pid == 0:
        try:
            operation()
        except BaseException:
            os._exit(1)
        os._exit(0)
    transcript = bytearray()
    answered = 0
    deadline = time.monotonic() + 40
    try:
        while time.monotonic() < deadline:
            if select.select([descriptor], [], [], 0.1)[0]:
                try:
                    chunk = os.read(descriptor, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                prompts = transcript.lower().count(b"enter passphrase") + transcript.lower().count(b"confirm passphrase")
                if prompts > answered:
                    os.write(descriptor, passphrase)
                    answered += 1
        else:
            os.kill(pid, 9)
            raise AssertionError("age interaction timed out")
        _, status = os.waitpid(pid, 0)
        assert (os.waitstatus_to_exitcode(status) == 0) == expected_success, "Unexpected age operation outcome"
        return bytes(transcript)
    finally:
        os.close(descriptor)
        transcript[:] = b"\0" * len(transcript)


def health():
    output = command("docker", "exec", NAME, "node", "-e",
                     "require('node:http').get('http://127.0.0.1:8787/health/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,...JSON.parse(b)})))})")
    return json.loads(output)


def main():
    with tempfile.TemporaryDirectory(prefix="abi-docker-auth-") as temporary:
        temp = Path(temporary)
        encrypted = temp / "dummy.age"
        preload = temp / "bybit-transport.cjs"
        preload.write_text('''const {createHmac}=require('node:crypto');
// Test-only response transport; production source/image has no accepted bypass.
globalThis.fetch=async (url,init)=>{
 if(url!=='https://api-demo.bybit.com/v5/user/query-api'||init.method!=='GET'||init.body!==undefined)throw new Error('Unexpected smoke request');
 const h=new Headers(init.headers);
 const expected=createHmac('sha256','smoke-secret').update(h.get('X-BAPI-TIMESTAMP')+'smoke-key'+h.get('X-BAPI-RECV-WINDOW')).digest('hex');
 if(h.get('X-BAPI-API-KEY')!=='smoke-key'||h.get('X-BAPI-SIGN')!==expected)throw new Error('Invalid smoke signature');
 return new Response(JSON.stringify({retCode:0,result:{apiKey:'smoke-key',userID:123,readOnly:0,permissions:{ContractTrade:['Order','Position']}}}));
};''')
        # Plaintext is pipe input only. age prompts through the controlling TTY.
        terminal(lambda: subprocess.run(["age", "-p", "-o", str(encrypted)], input=PAIR, check=True))
        command("docker", "run", "-d", "--name", NAME, "--memory=1g", "--memory-swap=1g", "--ulimit", "core=0",
                "--tmpfs", "/run/abi-authorization:rw,noexec,nosuid,size=64k,mode=0700,uid=1000,gid=1000",
                "--mount", f"type=bind,source={preload},target=/test/bybit-transport.cjs,readonly",
                "-e", "NODE_OPTIONS=--require=/test/bybit-transport.cjs", "-e", "ABI_EXPECTED_BYBIT_UID=123",
                "-e", "BYBIT_ENV=demo", "-e", "ABI_DRY_RUN=true", "-e", "ABI_LIVE_TRADING_ENABLED=false",
                "-e", "ABI_POSITION_SIZING_MODE=risk", "-e", "ABI_BYBIT_LINEAR_POSITION_BINDING_MODE=hedge",
                "-e", "ABI_BYBIT_HEARTBEAT_INTERVAL_MS=0", IMAGE)
        try:
            for _ in range(100):
                try:
                    if health()["authorization"] == "LOCKED":
                        break
                except (subprocess.CalledProcessError, ValueError):
                    pass
                time.sleep(0.1)
            else:
                raise AssertionError("Container did not start")
            assert health()["status"] == 503
            container_id = command("docker", "inspect", "--format", "{{.Id}}", NAME)
            # status does not require password; host CLI uses stdin relay inside the container.
            status = json.loads(command("python3", str(ROOT / "scripts/abi-authorize.py"), NAME, "status"))
            assert status["state"] == "LOCKED"
            terminal(lambda: subprocess.run(["python3", str(ROOT / "scripts/abi-authorize.py"), NAME, "authorize", str(encrypted)], check=True),
                     expected_success=False, passphrase=b"deliberately-wrong-test-passphrase\n")
            assert health()["authorization"] == "LOCKED"
            transcript = terminal(lambda: subprocess.run(["python3", str(ROOT / "scripts/abi-authorize.py"), NAME, "authorize", str(encrypted)], check=True))
            assert b'"result": "accepted"' in transcript
            for _ in range(100):
                ready = health()
                if ready["status"] == 200:
                    break
                time.sleep(0.05)
            assert ready["status"] == 200 and ready["authorization"] == "AUTHORIZED" and ready["localRecoveryReady"] and ready["bindingsVerified"]
            assert command("docker", "inspect", "--format", "{{.Id}}", NAME) == container_id
            command("docker", "restart", NAME)
            for _ in range(100):
                try:
                    ready = health()
                    if ready["authorization"] == "LOCKED":
                        break
                except (subprocess.CalledProcessError, ValueError):
                    pass
                time.sleep(0.1)
            assert ready["status"] == 503 and ready["authorization"] == "LOCKED"
            print("PASS: Docker LOCKED -> age password -> AUTHORIZED -> Trading READY, same container; restart -> LOCKED")
        finally:
            command("docker", "rm", "-f", NAME)


if __name__ == "__main__":
    main()
