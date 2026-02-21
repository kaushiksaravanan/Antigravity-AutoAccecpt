"""
AutoAccept-Antigravity Extension Test Script
=============================================
Run this script to verify the extension is working.
If AutoAccept is ON, Antigravity should auto-click "Run"
when it proposes executing this script.

The script prints a series of checks to confirm it ran successfully.
"""

import sys
import platform
import datetime


def main():
    print("=" * 50)
    print("  AutoAccept-Antigravity Test Script")
    print("=" * 50)
    print()
    print(f"  Python Version : {sys.version.split()[0]}")
    print(f"  Platform       : {platform.system()} {platform.release()}")
    print(f"  Timestamp      : {datetime.datetime.now().isoformat()}")
    print()
    print("  [OK] Script executed successfully!")
    print("  [OK] If you saw Antigravity auto-click 'Run',")
    print("       the extension is working correctly.")
    print()
    print("=" * 50)


if __name__ == "__main__":
    main()
