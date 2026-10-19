// A queued question's answer in the planner: the take being saved (or that failed to), or the
// recorded answer with its transcript and b-roll, and the buttons to record it.
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
export function AnswerBox({ qid, plan }) {
  const { brollOn } = useApp();
  const { m } = plan;
  const videoRef = useRef(null);
  const take = m.uploads.get(qid);
  if (take) {
    return (
      <View style={{ gap: 10 }}>
        <Video src={take.url} controls style={answerVideo} />
        {take.failed ? (
          <Row wrap gap={8}>
            <Small style={{ color: color.muted }}>Couldn't save this answer.</Small>
            <Button kind="primary" small title="Try again" onPress={() => plan.upload(qid, { ...take, failed: false })} />
            <Button small title="Discard" onPress={() => plan.discardUpload(qid)} />
          </Row>
        ) : (
          <Small style={{ color: color.muted }}>Saving…</Small>
        )}
      </View>
    );
  }
  const url = m.videos.get(qid);
  const transcript = m.transcripts.get(qid);
  const broll = m.brolls.get(qid);
  return (
    <View style={{ gap: 10 }}>
      {url ? (
        <>
          {/* Takes recorded on this page keep playing from the phone's copy once saved. */}
          <AnswerVideo src={m.local.get(qid) ?? url} captions={transcript?.captions} broll={broll?.status === 'ready' && broll.start != null ? broll : null} videoRef={videoRef} />
          <AnswerTranscript videoRef={videoRef} transcript={transcript} questionId={qid} pick={(q) => q.answerTranscript} onUpdate={(t) => (m.transcripts.set(qid, t), plan.bump())} editable />
          {brollOn ? <BrollPanel qid={qid} plan={plan} /> : null}
        </>
      ) : null}
      <Row wrap gap={8}>
        <Button kind={url ? 'soft' : 'primary'} small title={url ? 'Re-record from here' : '● Answer from here'} onPress={() => plan.startSession(qid)} />
        {url ? <Button small title="Remove" onPress={() => plan.removeAnswer(qid)} /> : null}
      </Row>
    </View>
  );
}

// Under a recorded answer, the expert describes a shot to cut away to while they talk, or uploads a
// video of their own (from the phone's camera roll), split screen or, if they tick Full screen first,
// full screen. The server makes the shot, which takes a few minutes, or gets the video ready, and
// places it where it fits what they're saying; the answer's video above then plays with it cut in.
// What they've typed, and ticked, is kept while the planner redraws.
function BrollPanel({ qid, plan }) {
  const { makesBroll } = useApp();
  const { m } = plan;
  const broll = m.brolls.get(qid);
  const file = useRef(null);
  useWatchQuestion(qid, broll?.status === 'pending', (q) => q.broll?.status !== 'pending', (q) => m.brolls.get(qid)?.status === 'pending' && plan.setBroll(qid, q.broll));
  const remove = async () => plan.setBroll(qid, (await api('DELETE', `/api/questions/${qid}/broll`)).broll);
  const head = (
    <Row wrap gap={10} style={{ alignItems: 'baseline' }}>
      <Label>B-roll</Label>
      {broll?.prompt ? <Text style={styles.prompt}>“{broll.prompt}”</Text> : null}
      {broll?.upload ? <Text style={styles.file}>{broll.upload}</Text> : null}
    </Row>
  );

  const form = (again = false) => {
    const draft = m.brollDrafts.get(qid) ?? (again ? (broll?.prompt ?? '') : '');
    const full = m.brollFull.get(qid) ?? (again && Boolean(broll?.full));
    return (
      <View style={{ gap: 8 }}>
        <Field
          value={draft}
          onChangeText={(text) => (m.brollDrafts.set(qid, text), plan.bump())}
          multiline
          rows={2}
          maxLength={500}
          aria-label={makesBroll ? 'Describe the b-roll' : 'What your video shows'}
          placeholder={makesBroll ? 'What to cut to while you talk, e.g. "Hands sketching a wireframe on paper" or "An animated diagram of a cache going stale"' : 'What your video shows, e.g. "Hands sketching a wireframe on paper"'}
        />
        {/* Before the buttons: picking a video starts uploading it. */}
        <Checkbox checked={full} onChange={(on) => (m.brollFull.set(qid, on), plan.bump())} label="Full screen" />
        <Row wrap gap={8}>
          {makesBroll ? (
            <Button
              kind="primary"
              small
              title={broll ? 'Make new b-roll' : 'Make b-roll'}
              onPress={async () => {
                const res = await api('POST', `/api/questions/${qid}/broll`, { prompt: draft });
                m.brollDrafts.delete(qid);
                m.brollFull.delete(qid);
                plan.setBroll(qid, res.broll);
              }}
            />
          ) : null}
          <Button kind={makesBroll ? 'ring' : 'primary'} small title="Upload a video" onPress={() => file.current.click()} />
          {broll ? <Button kind="ring" small title="Remove b-roll" onPress={remove} /> : null}
          {broll?.status === 'ready' ? <Button kind="link" small title="Cancel" onPress={() => (m.brollDrafts.delete(qid), m.brollFull.delete(qid), plan.bump())} /> : null}
        </Row>
        <input
          ref={file}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const picked = e.target.files[0];
            e.target.value = ''; // so picking the same file again still counts
            if (picked) plan.uploadBroll(qid, picked, draft, full);
          }}
        />
        <Hint>
          {makesBroll
            ? "A few seconds of video, shorter than your answer: footage, a diagram, an animation, whatever you describe. Labels work best kept to a few short words. Or upload a video of your own, saying above what it shows. It's cut in where you talk about it, and while it plays your answer moves to the top half of the screen. Tick Full screen before uploading a video to have it take the whole screen instead, with your voice over it."
            : "A video of your own, shorter than your answer. Say above what it shows, and it's cut in where you talk about it; while it plays your answer moves to the top half of the screen. Tick Full screen before uploading to have it take the whole screen instead, with your voice over it."}
        </Hint>
      </View>
    );
  };

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
  } else if (!broll) {
    body = (
      <>
        {head}
        {form()}
      </>
    );
  } else if (broll.status === 'pending') {
    body = (
      <>
        {head}
        <Small style={{ color: color.muted }}>{broll.upload ? 'Finding the best place for your video…' : 'Making your b-roll and finding the best place for it… This takes a few minutes; you can keep working.'}</Small>
        <Button kind="link" small title="Cancel" onPress={remove} style={{ alignSelf: 'flex-start' }} />
      </>
    );
  } else if (broll.status === 'failed') {
    body = (
      <>
        {head}
        <Warn>{broll.upload ? "Your video couldn't be used. Upload it again, or try another." : "This b-roll couldn't be made. Try again, or describe it differently."}</Warn>
        {form(true)}
      </>
    );
  } else if (m.brollDrafts.has(qid)) {
    body = (
      <>
        {head}
        {form(true)}
      </>
    );
  } else {
    body = (
      <>
        {head}
        {broll.start != null ? (
          <Small style={{ color: color.muted }}>
            Cut in {broll.full ? 'full screen ' : ''}at {fmtDuration(broll.start)}–{fmtDuration(broll.start + broll.length)}, where it fits what you're saying. Play your answer to see it.
          </Small>
        ) : (
          <Warn>This answer is too short for its b-roll, so it’s left out. Re-record a longer answer{broll.upload ? '' : ', or make new b-roll to fit this one'}.</Warn>
        )}
        {/* What was filmed, which may be a scene standing for the idea they described. */}
        {broll.shot && broll.shot !== broll.prompt ? (
          <Disclosure title={<Small style={{ color: color.muted }}>What was filmed</Small>}>
            <Small style={{ color: color.muted }}>{broll.shot}</Small>
          </Disclosure>
        ) : null}
        <Row wrap gap={8}>
          <Button kind="ring" small title="Change" onPress={() => (m.brollDrafts.set(qid, broll.prompt ?? ''), m.brollFull.set(qid, broll.full), plan.bump())} />
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
