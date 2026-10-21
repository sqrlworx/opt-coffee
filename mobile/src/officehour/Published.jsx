// A published office hour: the answers as one video, with its questions under it to skip to, then
// the discussion. The player docks under the top bar while they're scrolled, shrinking as the page
// scrolls on, so they stay the same distance under it. Without ffmpeg, or if joining failed, each
// answer has its own video instead.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { fmtDuration, plural } from '../format.js';
import { useWatchQuestion } from '../hooks.js';
import { AnswerVideo } from '../media/AnswerVideo.jsx';
import { INTO_ANSWER, JointPlayer } from '../media/JointPlayer.jsx';
import { QuestionText } from '../media/transcript.jsx';
import { DOCKED_TALL, STAGE, STAGE_TALL } from '../media/Video.jsx';
import { color, font, TOP_BAR_HEIGHT } from '../theme.js';
import { Disclosure, Notice, Row, SectionTitle, Small } from '../ui/index.jsx';
import { Discussion } from './Discussion.jsx';
import { QuestionMeta, QuestionRow } from './questions.jsx';

// The paper the docked player sits on, above and below it, and how far under the player Skip to is:
// the section's gap and Skip to's margin.
const DOCK_PAD = 8;
const LIST_GAP = 24;
// How tall the player may get: the room between where it sits and LIST_GAP above Skip to (`--room`,
// kept up to date as the page scrolls), at most its full height and at least half the screen.
const DOCK_TALL = `clamp(${DOCKED_TALL}, var(--room, ${STAGE_TALL}), ${STAGE_TALL})`;
// The player's height when it may get `tall`, as a margin works it out: its width over STAGE, at
// most `tall`, a margin's percentage being of the width, as the player's is.
const stageHeight = (tall) => `min(100% / ${STAGE}, ${tall})`;

export function PublishedAnswers({ oh, data }) {
  const { fail } = useApp();
  const [answers, setAnswers] = useState(data.answers);
  const [current, setCurrent] = useState(null);
  const player = useRef(null);
  const dock = useRef(null);
  const list = useRef(null);
  useRoom(dock, list);
  const replace = (q) => setAnswers((list) => list.map((x) => (x.id === q.id ? { ...x, ...q } : x)));
  // A transcript that's ready or corrected gets a new summary, written in the background.
  const changed = (q) => {
    replace(q);
    api('GET', `/api/questions/${q.id}`).then(({ question }) => replace({ id: q.id, transcript: question.transcript, summary: question.summary }), fail);
  };

  const answeredIds = new Set(answers.map((q) => q.id));
  const rest = data.groups.flatMap((g) => g.questions).filter((q) => !answeredIds.has(q.id));
  const joined = data.video?.status === 'ready';
  return (
    <View style={{ gap: 40 }}>
      <View style={{ gap: 16 }}>
        <SectionTitle>{plural(answers.length, 'answered question')}</SectionTitle>
        {joined ? (
          <>
            <View ref={dock} style={styles.dock}>
              <JointPlayer ref={player} answers={answers} video={data.video} onCurrent={setCurrent} tall={DOCK_TALL} />
            </View>
            <SkipTo listRef={list} answers={answers} video={data.video} current={current} play={(t) => player.current?.play(t + INTO_ANSWER)} onUpdate={replace} />
          </>
        ) : (
          <View style={{ gap: 36 }}>
            {answers.map((q, i) => (
              <View key={q.id} style={{ gap: 12 }}>
                <Row gap={10} style={{ alignItems: 'flex-start' }}>
                  <Text style={styles.num}>{String(i + 1).padStart(2, '0')}</Text>
                  <View style={{ flex: 1, gap: 6 }}>
                    <QuestionText q={q} />
                    <Row gap={10} style={{ justifyContent: 'space-between' }}>
                      <QuestionMeta q={q} />
                      <Small style={{ color: color.muted }}>▲ {q.votes}</Small>
                    </Row>
                  </View>
                </Row>
                <AnswerVideo src={q.video} captions={q.transcript?.captions} broll={q.broll} />
              </View>
            ))}
          </View>
        )}
      </View>
      <Discussion oh={oh} answers={answers} onChange={changed} />
      {/* Questions that weren't answered are the expert's alone; readers aren't sent them. */}
      {oh.isExpert && rest.length ? (
        <View style={styles.unanswered}>
          <Disclosure title={`${rest.length} question${rest.length === 1 ? ' was' : 's were'} not answered · only you see these`}>
            {rest.map((q, i) => (
              <QuestionRow key={q.id} q={q} canVote={false} first={i === 0} />
            ))}
          </Disclosure>
        </View>
      ) : null}
    </View>
  );
}

// Keeps `--room` on the dock up to date as the page scrolls: how tall the player can be with Skip to
// (`list`) LIST_GAP under it. Docked, the player stays put while Skip to scrolls on up towards it, so
// the player shrinks as fast as the page scrolls, and grows back the same way.
function useRoom(dock, list) {
  useEffect(() => {
    const update = () => {
      if (!dock.current || !list.current) return;
      const top = dock.current.getBoundingClientRect().top + DOCK_PAD;
      dock.current.style.setProperty('--room', `${list.current.getBoundingClientRect().top - LIST_GAP - top}px`);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [dock, list]);
}

// The questions under the video, to skip to: each where it starts, its number, and the moderator's
// few words for it, or the question cut short, in two lines at most. Tapping one plays it from the
// question; the one being played is highlighted.
function SkipTo({ listRef, answers, video, current, play, onUpdate }) {
  const starts = new Map(video.chapters.map((c) => [c.questionId, c.start]));
  const parts = answers.filter((q) => starts.has(q.id));
  return (
    <View ref={listRef} style={{ gap: 12, marginTop: 8 }}>
      <Text style={[styles.serif, { fontSize: 24, lineHeight: 30 }]}>Skip to</Text>
      <View style={{ borderTopWidth: 1, borderTopColor: color.line }}>
        {parts.map((q, i) => (
          <SkipItem key={q.id} q={q} n={i + 1} start={starts.get(q.id)} current={current === q.id} play={play} onUpdate={onUpdate} />
        ))}
      </View>
    </View>
  );
}

// Summaries are written once an answer is transcribed (and again when it's corrected), so answers
// still waiting for one are watched.
function SkipItem({ q, n, start, current, play, onUpdate }) {
  const { summary, transcript } = q;
  useWatchQuestion(q.id, transcript?.status === 'pending' || Boolean(summary?.pending), (x) => x.transcript?.status !== 'pending' && !x.summary?.pending, (x) => onUpdate({ id: q.id, transcript: x.transcript, summary: x.summary }));
  return (
    <Pressable onPress={() => play(start)} role="button" aria-label={`Play from ${fmtDuration(start)}`} aria-current={current} style={({ pressed }) => [styles.item, current && styles.current, pressed && { backgroundColor: color.raised }]}>
      <Text style={styles.time}>{fmtDuration(start)}</Text>
      <Text numberOfLines={2} style={[styles.serif, { flex: 1, fontSize: 19, lineHeight: 26 }]}>
        <Text style={{ color: color.accent }}>{String(n).padStart(2, '0')}  </Text>
        {summary?.question ?? q.body}
      </Text>
    </Pressable>
  );
}

// For the expert while their answers are being joined into one video, which takes a few minutes.
// The page shows the video as soon as it's ready.
export function ProcessingNote({ oh, onReady }) {
  const latest = useRef(onReady);
  latest.current = onReady;
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const { video } = await api('GET', `/api/office-hours/${oh.id}/video`, null, { timeout: 10_000 });
        if (stopped) return;
        if (video?.status !== 'pending') return latest.current();
      } catch {
        // failed or hung: try again on the next tick
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [oh.id]);
  return <Notice>Your answers are published, and the video is being processed. It usually takes a few minutes; this page shows it as soon as it’s ready. Until then, everyone else sees this off hour as closed.</Notice>;
}

const styles = StyleSheet.create({
  serif: { fontFamily: font.serif, color: color.ink },
  num: { fontFamily: font.serif, fontSize: 20, lineHeight: 28, color: color.accent, fontVariant: ['lining-nums', 'tabular-nums'] },
  item: { flexDirection: 'row', gap: 14, paddingVertical: 14, paddingLeft: 10, paddingRight: 12, borderBottomWidth: 1, borderBottomColor: color.line, borderLeftWidth: 2, borderLeftColor: 'transparent', cursor: 'pointer' },
  current: { borderLeftColor: color.accent, backgroundColor: color.raised },
  time: { minWidth: 38, paddingTop: 4, fontFamily: font.sans, fontSize: 13, color: color.muted, fontVariant: ['tabular-nums'] },
  // The player, docked under the top bar while Skip to is scrolled, until the list ends. Its paper
  // keeps the list from showing above it and beside it. The margins cancel the padding, and the one
  // under it makes up what the player has shrunk by, so the page under it doesn't move.
  dock: { position: 'sticky', top: `calc(${TOP_BAR_HEIGHT}px + env(safe-area-inset-top))`, zIndex: 5, marginTop: -DOCK_PAD, marginBottom: `calc(${stageHeight(STAGE_TALL)} - ${stageHeight(DOCK_TALL)} - ${DOCK_PAD}px)`, paddingVertical: DOCK_PAD, backgroundColor: color.paper },
  unanswered: { backgroundColor: color.raised, borderRadius: 18, paddingHorizontal: 20, paddingVertical: 6 },
});
