"""
Manual smoke script for Auto Accept.

Ask the agent to run this file. If Auto Accept is on, it should approve the run.
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
    print("=" * 50)


if __name__ == "__main__":
    main()
