# -*- coding: utf-8 -*-
"""Unit tests for alpha cleaning, unblending pure functions, and cache reuse validation."""
import sys
import unittest
from pathlib import Path
from PIL import Image

# 解决根目录下以 python -m unittest scripts/test_alpha_cleaner.py 执行时的路径导入
sys.path.insert(0, str(Path(__file__).parent.resolve()))

try:
    from prepare_room_character import (
        floor_faint_alpha,
        unblend_rgba,
        erode_alpha,
        should_reuse_clip,
    )
except ImportError:
    floor_faint_alpha = None
    unblend_rgba = None
    erode_alpha = None
    should_reuse_clip = None


class TestAlphaCleaner(unittest.TestCase):
    def test_import_exists(self):
        self.assertIsNotNone(floor_faint_alpha, "floor_faint_alpha must be importable")
        self.assertIsNotNone(unblend_rgba, "unblend_rgba must be importable")
        self.assertIsNotNone(erode_alpha, "erode_alpha must be importable")
        self.assertIsNotNone(should_reuse_clip, "should_reuse_clip must be importable")

    def test_floor_faint_alpha_clears_low_alpha(self):
        # 2x2 image with a=0, a=1, a=2, a=255
        im = Image.new("RGBA", (2, 2))
        im.putpixel((0, 0), (255, 255, 255, 0))    # a=0 -> (0,0,0,0)
        im.putpixel((1, 0), (240, 240, 240, 1))    # a=1 -> (0,0,0,0) [底板清理]
        im.putpixel((0, 1), (100, 150, 200, 2))    # a=2 -> (100, 150, 200, 2)
        im.putpixel((1, 1), (50, 50, 50, 255))     # a=255 -> (50, 50, 50, 255)

        cleaned = floor_faint_alpha(im)
        self.assertEqual(cleaned.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(cleaned.getpixel((1, 0)), (0, 0, 0, 0))
        self.assertEqual(cleaned.getpixel((0, 1)), (100, 150, 200, 2))
        self.assertEqual(cleaned.getpixel((1, 1)), (50, 50, 50, 255))

    def test_unblend_rgba_math(self):
        # True color (50, 100, 150), alpha 100/255.
        # Stored on white (255, 255, 255):
        # stored = round(char * a + 255 * (1 - a))
        # R: round(50 * 100/255 + 255 * 155/255) = 175
        # G: round(100 * 100/255 + 255 * 155/255) = 194
        # B: round(150 * 100/255 + 255 * 155/255) = 214
        im = Image.new("RGBA", (1, 1))
        im.putpixel((0, 0), (175, 194, 214, 100))

        unblended = unblend_rgba(im)
        p = unblended.getpixel((0, 0))
        self.assertAlmostEqual(p[0], 50, delta=3)
        self.assertAlmostEqual(p[1], 100, delta=3)
        self.assertAlmostEqual(p[2], 150, delta=3)
        self.assertEqual(p[3], 100)

    def test_unblend_rgba_extremes_unchanged(self):
        # Below UNBLEND_MIN_ALPHA (e.g. a=10) and above UNBLEND_MAX_ALPHA (e.g. a=252)
        im = Image.new("RGBA", (2, 1))
        im.putpixel((0, 0), (200, 200, 200, 10))
        im.putpixel((1, 0), (80, 80, 80, 252))

        unblended = unblend_rgba(im)
        self.assertEqual(unblended.getpixel((0, 0)), (200, 200, 200, 10))
        self.assertEqual(unblended.getpixel((1, 0)), (80, 80, 80, 252))

    def test_erode_alpha_reduces_isolated_pixel_and_respects_px(self):
        im = Image.new("RGBA", (5, 5), (0, 0, 0, 0))
        im.putpixel((2, 2), (255, 255, 255, 200))

        # px=1 should zero out isolated center pixel
        eroded1 = erode_alpha(im, px=1)
        self.assertEqual(eroded1.getpixel((2, 2))[3], 0)

        # px=0 should return unchanged
        eroded0 = erode_alpha(im, px=0)
        self.assertEqual(eroded0.getpixel((2, 2))[3], 200)


class TestCacheReuseLogic(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(__file__).parent / "test_tmp_reuse"
        self.test_dir.mkdir(parents=True, exist_ok=True)
        self.mock_webm = self.test_dir / "test.webm"
        self.mock_poster = self.test_dir / "test.webp"

        # Create valid mock files > 1024 / 512 bytes
        self.mock_webm.write_bytes(b"x" * 2048)
        self.mock_poster.write_bytes(b"y" * 1024)

    def tearDown(self):
        if self.test_dir.exists():
            import shutil
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_should_reuse_when_source_hash_matches(self):
        cached = {"source_sha256": "hash_aaa", "frames": 100}
        can_reuse, reason = should_reuse_clip(
            clip_id="test",
            dest_webm=self.mock_webm,
            dest_poster=self.mock_poster,
            cached_meta=cached,
            actual_src_hash="hash_aaa",
            force=False,
        )
        self.assertTrue(can_reuse)
        self.assertEqual(reason, "cache_valid")

    def test_should_reject_reuse_when_source_hash_changed(self):
        cached = {"source_sha256": "old_hash", "frames": 100}
        can_reuse, reason = should_reuse_clip(
            clip_id="test",
            dest_webm=self.mock_webm,
            dest_poster=self.mock_poster,
            cached_meta=cached,
            actual_src_hash="new_hash",
            force=False,
        )
        self.assertFalse(can_reuse)
        self.assertIn("source_hash_changed", reason)

    def test_should_reject_reuse_when_derivatives_missing(self):
        cached = {"source_sha256": "hash_aaa", "frames": 100}
        missing_webm = self.test_dir / "missing.webm"
        can_reuse, reason = should_reuse_clip(
            clip_id="test",
            dest_webm=missing_webm,
            dest_poster=self.mock_poster,
            cached_meta=cached,
            actual_src_hash="hash_aaa",
            force=False,
        )
        self.assertFalse(can_reuse)
        self.assertIn("derivative_files_missing", reason)

    def test_should_reject_reuse_when_cached_meta_missing(self):
        can_reuse, reason = should_reuse_clip(
            clip_id="test",
            dest_webm=self.mock_webm,
            dest_poster=self.mock_poster,
            cached_meta=None,
            actual_src_hash="hash_aaa",
            force=False,
        )
        self.assertFalse(can_reuse)
        self.assertIn("cached_meta_missing", reason)

    def test_should_reject_reuse_when_force_flag_passed(self):
        cached = {"source_sha256": "hash_aaa", "frames": 100}
        can_reuse, reason = should_reuse_clip(
            clip_id="test",
            dest_webm=self.mock_webm,
            dest_poster=self.mock_poster,
            cached_meta=cached,
            actual_src_hash="hash_aaa",
            force=True,
        )
        self.assertFalse(can_reuse)
        self.assertIn("force_requested", reason)


if __name__ == '__main__':
    unittest.main()
