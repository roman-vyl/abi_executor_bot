#!/usr/bin/env python3
"""Local age -> stdin -> container Unix socket. Does not start or deploy ABI."""
import argparse
import json
import re
import subprocess
import sys

LIMIT = 4096
RELAY = "/app/dist/authorization/credentialRelay.js"
CHECK = "const f=require('node:fs');if(f.statfsSync('/run/abi-authorization').type!==0x01021994||f.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim()!=='0')process.exit(1)"


def pair_from_plaintext(plaintext):
    pair = json.loads(plaintext.decode("utf-8"))
    if not isinstance(pair, list) or len(pair) != 2 or not all(
        isinstance(item, str) and len(item) <= 1024 and re.fullmatch(r"[A-Za-z0-9_-]+", item)
        for item in pair
    ):
        raise ValueError("Invalid credentials")
    return pair


def deliver(container, operation, encrypted=None):
    plaintext = bytearray()
    frame = bytearray()
    child = None
    try:
        # Check before requesting a password or decrypting any plaintext.
        subprocess.run(["docker", "exec", container, "node", "-e", CHECK],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        request = {"v": 1, "op": operation}
        if operation == "authorize":
            child = subprocess.Popen(["age", "--decrypt", "--", encrypted],
                                     stdout=subprocess.PIPE, stderr=None)
            # age prompts through the terminal; neither password nor plaintext enters argv/env.
            plaintext.extend(child.stdout.read(LIMIT + 1))
            if len(plaintext) > LIMIT:
                raise ValueError("Plaintext too large")
            if child.wait() != 0:
                raise ValueError("Decryption failed")
            request["credentials"] = pair_from_plaintext(plaintext)
        frame.extend((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
        if len(frame) > LIMIT:
            raise ValueError("Frame too large")
        result = subprocess.run(["docker", "exec", "-i", container, "node", RELAY], input=frame,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True)
        # Only print a closed vocabulary, never arbitrary child-process output.
        if len(result.stdout) > 1024:
            raise ValueError("Invalid response")
        response = json.loads(result.stdout)
        states = {"LOCKED", "VERIFYING", "RETRY_PENDING", "AUTHORIZED"}
        results = {"accepted", "rejected", "temporary_failure", "busy", "retry_required",
                   "already_authorized", "no_candidate", "protocol_error", "shutting_down"}
        if response.get("v") != 1 or response.get("state") not in states:
            raise ValueError("Invalid response")
        if "result" in response and response["result"] not in results:
            raise ValueError("Invalid response")
        safe = {"v": 1, "state": response["state"]}
        if "result" in response:
            safe["result"] = response["result"]
        return safe
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()
        plaintext[:] = b"\0" * len(plaintext)
        frame[:] = b"\0" * len(frame)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("container", help="Existing ABI container name or ID")
    parser.add_argument("operation", choices=["authorize", "retry", "status"])
    parser.add_argument("encrypted", nargs="?")
    args = parser.parse_args()
    if args.container.startswith("-") or (args.operation == "authorize") != (args.encrypted is not None):
        parser.error("authorize requires an age file; retry/status do not accept one")
    try:
        print(json.dumps(deliver(args.container, args.operation, args.encrypted)))
    except (Exception, KeyboardInterrupt):
        print("Authorization unavailable; check status before resending credentials", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
