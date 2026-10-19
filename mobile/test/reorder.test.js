// Dragging a card through the answer order (src/manage/reorder.js): where it lands, what makes room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, moved, scrollSpeed, shifts } from '../src/manage/reorder.js';

// Folded cards 80 tall, 14 apart, and a taller one at the end.
const tops = [100, 194, 288, 382];
const heights = [80, 80, 80, 120];

test('the held card goes past each card whose middle its own has passed', () => {
  assert.equal(dropIndex(tops, heights, 0, 0), 0, 'not moved');
  assert.equal(dropIndex(tops, heights, 0, 94), 0, 'level with the next card’s middle');
  assert.equal(dropIndex(tops, heights, 0, 95), 1);
  assert.equal(dropIndex(tops, heights, 0, 189), 2);
  assert.equal(dropIndex(tops, heights, 0, 1000), 3, 'past the end');
  assert.equal(dropIndex(tops, heights, 3, -113), 3);
  assert.equal(dropIndex(tops, heights, 3, -114), 2, 'up, past the middle of the card above');
  assert.equal(dropIndex(tops, heights, 3, -1000), 0, 'past the start');
});

test('the cards it passes slide out of its way, by its height and the gap', () => {
  assert.deepEqual(shifts(heights, 0, 2, 14), [0, -94, -94, 0]);
  assert.deepEqual(shifts(heights, 3, 1, 14), [0, 134, 134, 0]);
  assert.deepEqual(shifts(heights, 1, 1, 14), [0, 0, 0, 0], 'back where it was');
});

test('moving takes the item out and puts it in its new place', () => {
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b'], 1, 1), ['a', 'b']);
});

test('the page scrolls near either bar, faster the closer the card is held to it', () => {
  // Bars ending at 60 and starting at 700, with the 64-pixel band inside each.
  assert.equal(scrollSpeed(400, 60, 700), 0);
  assert.equal(scrollSpeed(124, 60, 700), 0, 'at the edge of the band');
  assert.ok(scrollSpeed(100, 60, 700) < 0, 'up, near the top');
  assert.ok(scrollSpeed(80, 60, 700) < scrollSpeed(100, 60, 700), 'faster nearer');
  assert.equal(scrollSpeed(0, 60, 700), -1.2, 'at most 1.2 pixels a millisecond');
  assert.ok(scrollSpeed(680, 60, 700) > 0, 'down, near the bottom');
  assert.equal(scrollSpeed(900, 60, 700), 1.2);
});
