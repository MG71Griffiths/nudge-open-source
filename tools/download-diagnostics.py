#!/usr/bin/env python3
"""Download only Nudge's bounded diagnostic file; never copies photos/diary/keys."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True, help='Paired iPhone identifier from xcrun devicectl list devices')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    destination = root / '.local' / 'diagnostics' / stamp
    destination.mkdir(parents=True, mode=0o700)
    os.chmod(destination, 0o700)
    report = destination / 'events.json'
    with (destination / 'transfer.log').open('w') as log:
        result = subprocess.run([
            'xcrun', 'devicectl', 'device', 'copy', 'from', '--device', args.device,
            '--source', 'Library/Application Support/NudgeDiagnostics/events.json',
            '--destination', str(report), '--domain-type', 'appDataContainer',
            '--domain-identifier', 'org.example.nudge', '--timeout', '45'
        ], stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print('Could not retrieve diagnostics. Connect/unlock the paired phone and open the updated Nudge once. Transfer details:', destination / 'transfer.log')
        return result.returncode
    os.chmod(report, 0o600)
    if report.stat().st_size > 262144:
        print('Unexpected diagnostic size; file retained privately for inspection.')
        return 1
    try:
        data = json.loads(report.read_text())
        events = data['events']
        if data.get('version') != 1 or not isinstance(events, list) or len(events) > 200:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        print('Unexpected diagnostic format; file retained privately for inspection.')
        return 1
    # Raw file is data, never commands. Avoid echoing any untrusted event text.
    print('Downloaded', len(events), 'diagnostic events to', report)
    print('Only diagnostics were copied; the phone and diary were not changed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
