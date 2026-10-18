// The recording session (session.js) on a phone: full screen, the camera above and the question
// and its controls below. Where the page plays the asker's video as a small picture over the camera
// preview, this splits the camera's frame: the asker's video in the top half while their question
// plays, the camera in the bottom half. The rest of the time the camera has all of it.
import { useEffect, useReducer, useRef } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fmtDuration } from '../format.js';
import { layer, useStage } from '../media/Video.jsx';
import { QuestionMeta } from '../officehour/questions.jsx';
import { color, font, MAX_WIDTH, radius } from '../theme.js';
import { Button, Hint, Label, Row, Serif, Small, Warn } from '../ui/index.jsx';

// `queue` numbers the questions as the answer order does; `hasAnswer(qid)` and `saving` (takes
// still uploading) come from the planner.
export function Studio({ session, questions, queue, hasAnswer, saving }) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const { ref: stageRef, wide } = useStage();
  const preview = useRef(null);
  const pipSlot = useRef(null);
  const { state } = session;

  useEffect(() => {
    const video = preview.current;
    video.muted = true; // don't play the mic back into the room
    video.srcObject = session.camera;
    video.play().catch(() => {});
    session.start(pipSlot.current);
  }, [session]);
  // The clock ticks while a take records.
  useEffect(() => {
    const timer = setInterval(redraw, 250);
    return () => clearInterval(timer);
  }, []);

  // Before the first take starts (and between takes) there's only the camera to show.
  const { index, order } = state;
  const take = state.take ?? { qid: order[index], loading: true };
  const q = questions.get(take.qid);
  const last = index === order.length - 1;
  const upNext = last ? null : questions.get(order[index + 1]);
  const split = Boolean(state.clip && state.clipShown);
  const secs = take.loading ? 0 : ((take.exiting || performance.now()) - take.started) / 1000;
  const badge = take.loading ? '○ GETTING READY' : take.exiting ? `❚❚ PAUSED ${fmtDuration(secs)}` : `● REC ${fmtDuration(secs)}`;
  // Esc on a keyboard, or Back on Android, mustn't end a recording by accident: it asks, like Exit
  // (and a second time goes back to recording).
  const back = () => (take.exiting ? session.keepRecording() : session.exit());

  return (
    <Modal visible animationType="slide" onRequestClose={back}>
      <View style={styles.screen} role="dialog" aria-label="Recording answers">
        <div ref={stageRef} style={stage}>
          <video ref={preview} autoPlay playsInline muted style={layer(split ? 'bottom' : 'full', wide, { fit: 'cover', extra: { transform: 'scaleX(-1)' } })} />
          <div ref={pipSlot} style={layer('top', wide, { shown: split, z: 1, extra: { background: '#111', overflow: 'hidden' } })} />
          <div style={layer('top', wide, { shown: split, z: 2 })}>
            <span style={pill}>{state.label}</span>
          </div>
          <div style={layer(split ? 'bottom' : 'full', wide, { z: 2 })}>
            <span style={{ ...recBadge, background: take.exiting ? color.ink2 : color.accent }}>{badge}</span>
          </div>
        </div>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panel}>
          <Row wrap gap={8} style={{ justifyContent: 'space-between' }}>
            <Label>
              Question {queue.indexOf(take.qid) + 1} · {index + 1} of {order.length} in this session
            </Label>
            {saving ? <Small style={{ color: color.muted }}>Saving {saving} answer{saving === 1 ? '' : 's'}…</Small> : null}
          </Row>
          <Serif style={styles.question}>{q.body}</Serif>
          <QuestionMeta q={q} />
          {hasAnswer(take.qid) ? <Warn>This question already has an answer. Answering it again replaces it; {last ? 'exiting without saving' : 'Skip'} keeps it.</Warn> : null}
          <Text style={[styles.status, take.answering && { color: color.accent }]}>{take.loading ? 'Loading the question…' : take.answering ? '● Your answer' : 'Playing the question…'}</Text>
          {upNext ? (
            <View style={styles.next}>
              <Small style={{ color: color.muted }}>Up next</Small>
              <Serif style={{ fontSize: 17, lineHeight: 24 }}>{upNext.body}</Serif>
              {hasAnswer(upNext.id) ? <Warn>Already answered. Answering it again replaces that answer; Skip keeps it.</Warn> : null}
            </View>
          ) : (
            <Small style={{ color: color.muted }}>This is the last question in your answer order.</Small>
          )}
          <Hint>Wear headphones, so your microphone doesn't pick up the question a second time.</Hint>
        </ScrollView>
        <View style={styles.actions}>
          {take.exiting ? (
            <>
              <Text style={styles.exitAsk}>Save your answer to this question before exiting?</Text>
              <Row gap={8}>
                <Button kind="primary" title="Save" grow onPress={() => session.finishExit(true)} />
                <Button title="Discard" grow onPress={() => session.finishExit(false)} />
              </Row>
              <Button kind="link" title="Keep recording" onPress={session.keepRecording} style={{ alignSelf: 'center' }} />
            </>
          ) : (
            <>
              {take.answering ? <Button kind="primary" title="Save" onPress={session.next} /> : null}
              <Row gap={8}>
                {/* On the last question, skipping is the same as exiting without saving. */}
                {last ? null : <Button title="Skip →" grow onPress={session.skip} label="Skip: leave this question's answer as it is and play the next one" />}
                <Button title="↺ Start over" grow onPress={session.restart} label="Start over: play the question again and redo your answer" />
                <Button kind="ring" title="Exit" grow onPress={session.exit} />
              </Row>
              {take.answering ? <Hint style={{ textAlign: 'center' }}>{last ? 'Save keeps this answer and ends the session.' : 'Save keeps this answer and plays the next question.'}</Hint> : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const stage = { position: 'relative', width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', aspectRatio: '8 / 9', maxHeight: '54vh', background: '#000', overflow: 'hidden', flexShrink: 0 };
const pill = { position: 'absolute', left: 10, bottom: 10, padding: '2px 10px', borderRadius: 999, background: 'rgba(0,0,0,0.55)', color: '#fff', font: "600 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif", whiteSpace: 'nowrap' };
const recBadge = { position: 'absolute', top: 10, left: 10, padding: '3px 10px', borderRadius: 999, color: '#fff', font: "700 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif", letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.raised, paddingTop: 'env(safe-area-inset-top)' },
  panel: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', padding: 20, gap: 14 },
  question: { fontSize: 24, lineHeight: 31, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  status: { fontFamily: font.sans, fontSize: 16, fontWeight: '600', color: color.ink2 },
  next: { gap: 2, padding: 14, backgroundColor: color.surface, borderRadius: radius.sm },
  actions: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 'max(14px, env(safe-area-inset-bottom))', borderTopWidth: 1, borderTopColor: color.line, backgroundColor: color.raised },
  exitAsk: { fontFamily: font.sans, fontSize: 16, fontWeight: '600', color: color.ink, textAlign: 'center' },
});
