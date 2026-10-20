// A queued question's answer in the planner: the take being saved (or that failed to), or the
// recorded answer with its transcript and b-roll; and, apart, the buttons to record it.
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { fmtDuration } from '../format.js';
import { useWatchQuestion } from '../hooks.js';
import { AnswerVideo } from '../media/AnswerVideo.jsx';
import { AnswerTranscript } from '../media/transcript.jsx';
import { Video } from '../media/Video.jsx';
import { color, font, radius } from '../theme.js';
import { Button, Checkbox, Disclosure, Field, Hint, Label, Row, Small, Warn } from '../ui/index.jsx';

// `plan` is the planner's state (Manage.jsx): what each question has, and what can be done to it.
// Nothing until there's an answer, or a take of one.
export function AnswerBox({ qid, plan }) {
  const { brollOn } = useApp();
  const { m } = plan;
  const videoRef = useRef(null);
  const take = m.uploads.get(qid);
  if (take) return <Video src={take.url} controls style={answerVideo} />;
  const url = m.videos.get(qid);
  if (!url) return null;
  const transcript = m.transcripts.get(qid);
  const broll = m.brolls.get(qid);
  return (
    <View style={{ gap: 10 }}>
      {/* Takes recorded on this page keep playing from the phone's copy once saved. */}
      <AnswerVideo src={m.local.get(qid) ?? url} captions={transcript?.captions} broll={broll?.status === 'ready' && broll.start != null ? broll : null} videoRef={videoRef} />
      <AnswerTranscript videoRef={videoRef} transcript={transcript} questionId={qid} pick={(q) => q.answerTranscript} onUpdate={(t) => (m.transcripts.set(qid, t), plan.bump())} editable />
      {brollOn ? <BrollPanel qid={qid} plan={plan} videoRef={videoRef} /> : null}
    </View>
  );
}

// The buttons under an answer, for a row of the planner's: to record it, or the take being saved.
export function AnswerActions({ qid, plan }) {
  const { m } = plan;
  const take = m.uploads.get(qid);
  if (take) {
    if (!take.failed) return <Small style={{ color: color.muted }}>Saving…</Small>;
    return (
      <>
        <Small style={{ color: color.muted }}>Couldn't save this answer.</Small>
        <Button kind="primary" small title="Try again" onPress={() => plan.upload(qid, { ...take, failed: false })} />
        <Button small title="Discard" onPress={() => plan.discardUpload(qid)} />
      </>
    );
  }
  const url = m.videos.get(qid);
  return (
    <>
      <Button kind={url ? 'soft' : 'primary'} small title={url ? 'Re-record' : 'Answer from here'} onPress={() => plan.startSession(qid)} />
      {url ? <Button small title="Remove" onPress={() => plan.removeAnswer(qid)} /> : null}
    </>
  );
}

// Under a recorded answer, the expert makes b-roll to cut away to while they talk, describing it
// once Make b-roll opens the box for that, or uploads a video of their own from the phone's camera
// roll. The server makes the shot, which takes a few minutes, or gets the video ready, and places it
// where it fits what they're saying; the answer's video above then plays with it cut in. They can
// then cut in to it where the answer's video (`videoRef`) is instead. An uploaded video can go full
// screen, and then keep playing past the end of the answer. What they've typed is kept while the
// planner redraws.
function BrollPanel({ qid, plan, videoRef }) {
  const { makesBroll, brollModel, fail } = useApp();
  const { m } = plan;
  const broll = m.brolls.get(qid);
  const file = useRef(null);
  useWatchQuestion(qid, broll?.status === 'pending', (q) => q.broll?.status !== 'pending', (q) => m.brolls.get(qid)?.status === 'pending' && plan.setBroll(qid, q.broll));
  const remove = async () => plan.setBroll(qid, (await api('DELETE', `/api/questions/${qid}/broll`)).broll);
  const patch = (body) => api('PATCH', `/api/questions/${qid}/broll`, body).then((res) => plan.setBroll(qid, res.broll), fail);
  const draft = m.brollDrafts.get(qid); // what's typed in the box, while it's open
  const changing = m.brollChanging.has(qid);
  const model = makesBroll && brollModel ? <Hint>model: {brollModel}</Hint> : null;
  const head = (
    <Row wrap gap={10} style={{ alignItems: 'baseline' }}>
      <Label>B-roll</Label>
      {broll?.prompt ? <Text style={styles.prompt}>“{broll.prompt}”</Text> : null}
      {broll?.upload ? <Text style={styles.file}>{broll.upload}</Text> : null}
    </Row>
  );

  // Make b-roll opens the box, with what was asked for last if it's being changed or failed;
  // Upload a video picks one and sends it.
  const choose = (
    <View style={{ gap: 8 }}>
      <Row wrap gap={8}>
        {makesBroll ? <Button kind="primary" small title="Make b-roll" onPress={() => (m.brollDrafts.set(qid, broll && !broll.upload ? (broll.prompt ?? '') : ''), plan.bump())} /> : null}
        <Button kind={makesBroll ? 'ring' : 'primary'} small title="Upload a video" onPress={() => file.current.click()} />
        {broll?.status === 'failed' ? <Button kind="ring" small title="Remove b-roll" onPress={remove} /> : null}
        {changing ? <Button kind="link" small title="Cancel" onPress={() => (m.brollChanging.delete(qid), plan.bump())} /> : null}
      </Row>
      <input
        ref={file}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const picked = e.target.files[0];
          e.target.value = ''; // so picking the same file again still counts
          if (picked) plan.uploadBroll(qid, picked);
        }}
      />
      {makesBroll ? model : <Hint>{"A video of your own. It's cut in where you talk about it, and while it plays your answer moves to the top half of the screen; then you can choose where."}</Hint>}
    </View>
  );

  let body;
  const up = m.brollUploads.get(qid);
  if (up) {
    // Cancel stops sending it; once it's all sent, the server's getting it ready.
    body = (
      <>
        <Row wrap gap={10}>
          <Label>B-roll</Label>
          <Text style={styles.file}>{up.name}</Text>
        </Row>
        <View style={styles.track}>
          <View style={[styles.progress, { width: `${Math.floor(up.sent * 100)}%` }]} />
        </View>
        <Row wrap gap={10}>
          <Small style={{ color: color.muted }}>{up.sent < 1 ? `Uploading… ${Math.floor(up.sent * 100)}%` : 'Getting your video ready…'}</Small>
          {up.sent < 1 ? <Button kind="link" small title="Cancel" onPress={() => up.stop.abort()} /> : null}
        </Row>
      </>
    );
  } else if (broll?.status === 'pending') {
    body = (
      <>
        {head}
        <Small style={{ color: color.muted }}>{broll.upload ? 'Finding the best place for your video…' : 'Making your b-roll and finding the best place for it… This takes a few minutes; you can keep working.'}</Small>
        <Button kind="link" small title="Cancel" onPress={remove} style={{ alignSelf: 'flex-start' }} />
      </>
    );
  } else if (draft != null) {
    body = (
      <>
        {head}
        <View style={{ gap: 8 }}>
          <Field
            value={draft}
            onChangeText={(text) => (m.brollDrafts.set(qid, text), plan.bump())}
            multiline
            rows={2}
            maxLength={500}
            autoFocus
            aria-label="Describe the b-roll"
            placeholder='What to cut to while you talk, e.g. "Hands sketching a wireframe on paper" or "An animated diagram of a cache going stale"'
          />
          <Row wrap gap={8}>
            <Button
              kind="primary"
              small
              title="Make b-roll"
              disabled={!draft.trim()}
              onPress={async () => {
                const res = await api('POST', `/api/questions/${qid}/broll`, { prompt: draft });
                m.brollDrafts.delete(qid);
                m.brollChanging.delete(qid);
                plan.setBroll(qid, res.broll);
              }}
            />
            <Button kind="link" small title="Cancel" onPress={() => (m.brollDrafts.delete(qid), plan.bump())} />
          </Row>
          {model}
        </View>
      </>
    );
  } else if (!broll || broll.status === 'failed' || changing) {
    body = (
      <>
        {head}
        {broll?.status === 'failed' ? <Warn>{broll.upload ? "Your video couldn't be used. Upload it again, or try another." : "This b-roll couldn't be made. Try again, or describe it differently."}</Warn> : null}
        {choose}
      </>
    );
  } else {
    const chosen = broll.chosen != null;
    body = (
      <>
        {head}
        {broll.start != null ? (
          <Small style={{ color: color.muted }}>
            Cut in {broll.full ? 'full screen ' : ''}at {fmtDuration(broll.start)}–{fmtDuration(broll.start + broll.length)}, {chosen ? 'where you chose' : "where it fits what you're saying"}. Play your answer to see it.
          </Small>
        ) : chosen ? (
          <Warn>There's no room for b-roll after {fmtDuration(broll.chosen)}, where you chose. Pick an earlier moment, or let the moderator choose.</Warn>
        ) : (
          <Warn>This answer is too short for its b-roll, so it’s left out. Re-record a longer answer{broll.upload ? '' : ', or make new b-roll to fit this one'}.</Warn>
        )}
        {/* Not all of a video they uploaded plays when it's longer than the time left in the answer. */}
        {broll.upload && broll.start != null && broll.clipLength > broll.length + 0.5 ? (
          <Small style={{ color: color.muted }}>
            Only {fmtDuration(broll.length)} of your {fmtDuration(broll.clipLength)} video fits before your answer ends.
          </Small>
        ) : null}
        {/* Where it cuts in: where the answer's video is, which they play, scrub or tap the transcript to. */}
        <View style={{ gap: 6 }}>
          <Row wrap gap={8}>
            <Button kind="ring" small title="Cut in here" onPress={() => patch({ start: Math.round(videoRef.current.currentTime * 1000) / 1000 })} />
            {chosen ? <Button kind="link" small title="Let the moderator choose" onPress={() => patch({ start: null })} /> : null}
          </Row>
          <Hint>Play your answer, or tap a line of its transcript, to where the b-roll should start, then tap Cut in here.</Hint>
        </View>
        {/* An uploaded video can fill the screen instead, and then keep playing past the end of the answer; it's placed again to suit. */}
        {broll.upload ? <Checkbox checked={broll.full} onChange={(full) => patch({ full })} label="Full screen" /> : null}
        {broll.upload && broll.full ? (
          <View style={{ gap: 2 }}>
            <Checkbox checked={broll.pastEnd} onChange={(pastEnd) => patch({ pastEnd })} label="Keep playing past the end of my answer" />
            <Hint>Your answer gets longer, silent under your video.</Hint>
          </View>
        ) : null}
        {/* What was filmed, which may be a scene standing for the idea they described. */}
        {broll.shot && broll.shot !== broll.prompt ? (
          <Disclosure title={<Small style={{ color: color.muted }}>What was filmed</Small>}>
            <Small style={{ color: color.muted }}>{broll.shot}</Small>
          </Disclosure>
        ) : null}
        <Row wrap gap={8}>
          <Button kind="ring" small title="Change" onPress={() => (m.brollChanging.add(qid), plan.bump())} />
          <Button kind="ring" small title="Remove" onPress={remove} />
        </Row>
      </>
    );
  }
  return <View style={styles.panel}>{body}</View>;
}

const answerVideo = { background: '#111', borderRadius: 12 };

const styles = StyleSheet.create({
  panel: { gap: 10, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.sm, backgroundColor: color.surface },
  prompt: { fontFamily: font.serif, fontStyle: 'italic', fontSize: 16, color: color.ink, flexShrink: 1 },
  file: { fontFamily: font.sans, fontSize: 14, color: color.ink2, flexShrink: 1 },
  track: { height: 4, borderRadius: 2, backgroundColor: color.surface2, overflow: 'hidden' },
  progress: { height: 4, backgroundColor: color.accent },
});
