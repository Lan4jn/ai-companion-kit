#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
from pathlib import Path

# Ensure local script directory is in sys.path
sys.path.insert(0, str(Path(__file__).parent.resolve()))

from prepare_room_character import main

if __name__ == "__main__":
    main()
