"""Score-box reading without a video: synthetic digit cells through find_goals."""
import unittest

from goal_clips import Cell, find_goals

W, H = 60, 56


def digit(n):
    """A light cell with a dark block whose position stands in for the digit n."""
    gray = bytearray([235]) * (W * H)
    for y in range(12, 44):
        for x in range(8 + 4 * n, 20 + 4 * n):
            gray[y * W + x] = 40
    return Cell.read(bytes(gray), W)


ICE = Cell.read(bytes([230]) * (W * H), W)          # no digit: the box is hidden


def play(script):
    """script: [(top digit or None, bottom digit or None)], one entry per 5 s keyframe."""
    cell = lambda n: None if n is None else digit(n)
    return find_goals((i * 5.0, {"top": cell(a), "bottom": cell(b)}) for i, (a, b) in enumerate(script))


class ScoreBox(unittest.TestCase):
    def test_cells_are_recognised_only_when_the_box_is_showing(self):
        self.assertIsNone(ICE)
        self.assertIsNotNone(digit(0))
        self.assertTrue(digit(1).same(digit(1)))
        self.assertFalse(digit(1).same(digit(2)))
        dark_edge = bytearray([235]) * (W * H)
        dark_edge[:W * 10] = bytes([40]) * (W * 10)   # a player skating behind the corner
        self.assertIsNone(Cell.read(bytes(dark_edge), W))

    def test_each_score_change_is_one_goal_with_the_running_score(self):
        goals = play([(0, 0)] * 3 + [(1, 0)] * 3 + [(1, 1)] * 3 + [(2, 1)] * 3)
        self.assertEqual([(g["row"], g["top"], g["bottom"]) for g in goals],
                         [("top", 1, 0), ("bottom", 1, 1), ("top", 2, 1)])
        self.assertEqual((goals[0]["earliest"], goals[0]["latest"]), (10.0, 15.0))

    def test_the_box_appearing_late_or_blinking_out_is_not_a_goal(self):
        self.assertEqual(play([(None, None)] * 4 + [(0, 0)] * 3 + [(None, None)] * 2 + [(0, 0)] * 3), [])

    def test_a_score_that_changed_while_the_box_was_hidden_still_counts(self):
        goals = play([(0, 0)] * 3 + [(None, None)] * 2 + [(1, 0)] * 3)
        self.assertEqual(len(goals), 1)
        self.assertEqual((goals[0]["earliest"], goals[0]["latest"]), (10.0, 25.0))

    def test_a_single_odd_frame_is_ignored(self):
        self.assertEqual(play([(0, 0)] * 3 + [(1, 0)] + [(0, 0)] * 3), [])

    def test_a_goal_the_operator_took_back_is_dropped(self):
        goals = play([(0, 0)] * 3 + [(1, 0)] * 3 + [(1, 1)] * 3 + [(0, 1)] * 3 + [(0, 2)] * 3)
        self.assertEqual([(g["row"], g["top"], g["bottom"]) for g in goals], [("bottom", 0, 1), ("bottom", 0, 2)])


if __name__ == "__main__":
    unittest.main()
