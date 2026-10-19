// Asking a question: typed (and read aloud to the expert in a voice the asker picks), or, when the
// server can transcribe, spoken or asked on camera, then checked before it's asked.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { fmtDuration } from '../format.js';
import { useLeaveGuard, useMounted } from '../hooks.js';
import { CueLines } from '../media/transcript.jsx';
import { AUDIO_RECORDING_TYPES, AudioPlayer, HALF, MAX_QUESTION_SECS, QUESTION_CAMERA, RECORDING_TYPES, Video } from '../media/Video.jsx';
import { color, font, radius } from '../theme.js';
import { Button, Checkbox, Field, Hint, Label, Link, Row, Segmented, Serif, Small, confirmed } from '../ui/index.jsx';

export function AskForm({ oh, onAsked }) {
  const { me, speech, voices, voice: myVoice, setVoice, toast } = useApp();
  const [mode, setMode] = useState('text');
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [voice, pickVoice] = useState(() => (voices.some((v) => v.id === myVoice) ? myVoice : voices[0]?.id));
  const [busy, setBusy] = useState(false); // a recording that hasn't been asked yet
  useLeaveGuard(busy);

  if (!me) {
    return (
      <Serif style={{ fontSize: 19, fontStyle: 'italic', color: color.muted }}>
        <Link to={`#/login?next=${encodeURIComponent(`#/oh/${oh.id}`)}`} style={{ fontStyle: 'normal' }}>
          Log in
        </Link>{' '}
        to ask a question.
      </Serif>
    );
  }

  const switchMode = (next) => {
    if (next === mode) return;
    if (busy && !confirmed("Discard the recording you haven't sent?")) return;
    setBusy(false);
    setMode(next); // the recorder that's left lets go of the microphone and camera
  };
  const asked = (question) => {
    toast("Question submitted — you'll be notified when it's answered", 'success');
    onAsked?.(question);
  };

  return (
    <View style={{ gap: 18 }}>
      {speech ? <Segmented label="How to ask" value={mode} onChange={switchMode} options={[['text', 'Type'], ['audio', 'Speak'], ['video', 'Video']]} /> : null}
      {mode === 'text' ? (
        <>
          <Field value={body} onChangeText={setBody} multiline rows={2} maxLength={500} placeholder={`Ask ${oh.expert.displayName} something…`} inputStyle={styles.askInput} />
          {voices.length > 1 ? <VoicePicker voices={voices} value={voice} onChange={pickVoice} /> : null}
        </>
      ) : (
        <SpokenQuestion key={mode} oh={oh} camera={mode === 'video'} anonymous={anonymous} onAsked={asked} onBusy={setBusy} />
      )}
      {oh.allowAnonymous ? <Checkbox checked={anonymous} onChange={setAnonymous} label="Ask anonymously" /> : <Small style={{ color: color.muted }}>Your name will be shown with your question.</Small>}
      {mode !== 'text' && anonymous ? (
        <Hint>{mode === 'video' ? 'Your name is hidden, but your video is public, and people may recognize you.' : 'Your name is hidden, but your recording is public, and people may recognize your voice.'}</Hint>
      ) : null}
      {mode === 'text' ? (
        <Button
          kind="primary"
          title="Ask"
          disabled={!body.trim()}
          onPress={async () => {
            const { question } = await api('POST', `/api/office-hours/${oh.id}/questions`, { body, anonymous, voice: voices.length > 1 ? voice : undefined });
            setBody('');
            if (voices.length > 1) setVoice(voice); // the server keeps it as their voice for next time
            asked(question);
          }}
        />
      ) : null}
    </View>
  );
}

// Picks the voice a typed question is read aloud in from a dropdown, starting from the one the asker
// picked last time. The button beside it plays a short sample of the voice picked; a second tap stops it.
function VoicePicker({ voices, value, onChange }) {
  const { toast } = useApp();
  const [playing, setPlaying] = useState(null); // { loading } of the sample being played
  const audio = useRef(null);
  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = voices.find((v) => v.id === value) ?? voices[0];
  const option = (v) => (
    <option key={v.id} value={v.id}>
      {v.name}
    </option>
  );
  const accents = [...new Set(voices.map((v) => v.accent).filter(Boolean))];
  const pick = (id) => {
    stop(); // it was the last voice's sample
    onChange(id);
  };
  const preview = () => {
    if (playing) return stop();
    const sample = new Audio(picked.sample);
    audio.current = sample;
    setPlaying({ loading: true }); // the first preview of a voice takes a moment to make
    sample.addEventListener('playing', () => audio.current === sample && setPlaying({ loading: false }));
    sample.addEventListener('ended', () => audio.current === sample && stop());
    sample.addEventListener('error', () => {
      if (audio.current !== sample) return;
      stop();
      toast(`Couldn't play ${picked.name}'s voice right now`, 'error');
    });
    sample.play().catch(() => {}); // a failed load is reported by the error event
  };
  return (
    <View style={{ gap: 8 }}>
      <Label>Read aloud to the expert in</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {/* Grouped by accent, so the closed dropdown needs only the voice's name. */}
        <select className="native-input" aria-label="Read aloud to the expert in" value={picked.id} onChange={(e) => pick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
          {voices.filter((v) => !v.accent).map(option)}
          {accents.map((accent) => (
            <optgroup key={accent} label={accent}>
              {voices.filter((v) => v.accent === accent).map(option)}
            </optgroup>
          ))}
        </select>
        <Pressable role="button" aria-label={`Hear ${picked.name}`} aria-pressed={Boolean(playing)} onPress={preview} style={[styles.voicePlay, playing && { backgroundColor: color.accent }]}>
          <Text style={[styles.voicePlayText, playing && { color: color.accentInk }]}>{playing ? (playing.loading ? '…' : '■') : '▶'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Records a question out loud, or on camera with `camera` (the front one, in the shape of the top
// half of the player, where it's shown). When the asker stops, the recording is transcribed, and
// they can play it back and correct the transcript (it becomes the question's text) before asking.
// Leaving lets go of the microphone and camera, and of a recording that wasn't asked.
function SpokenQuestion({ oh, camera, anonymous, onAsked, onBusy }) {
  const { fail } = useApp();
  const mounted = useMounted();
  const [state, setState] = useState({ step: 'idle' });
  const [lines, setLines] = useState([]);
  const [secs, setSecs] = useState(0);
  const r = useRef({ stream: null, recorder: null, take: null, draft: null, timer: 0 }).current;
  const preview = useRef(null);
  const show = (next) => mounted.current && setState(next);

  const stopMic = () => {
    clearInterval(r.timer);
    r.stream?.getTracks().forEach((t) => t.stop());
    r.stream = null;
  };
  const close = () => {
    if (r.recorder?.state === 'recording') {
      r.recorder.onstop = null;
      r.recorder.stop();
    }
    r.recorder = null;
    stopMic();
    if (r.take) URL.revokeObjectURL(r.take.url);
    r.take = null;
    if (r.draft) api('DELETE', `/api/recordings/${r.draft.id}`).catch(() => {}); // the server would drop it after a day anyway
    r.draft = null;
    onBusy(false);
    show({ step: 'idle' });
  };
  useEffect(() => close, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state.step === 'recording' && camera && preview.current) {
      preview.current.muted = true; // don't play the mic back into the room
      preview.current.srcObject = r.stream;
    }
  }, [state.step, camera, r]);

  async function record() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error(`This browser can't record ${camera ? 'video' : 'audio'}. Try a recent Chrome, Firefox or Safari.`);
    }
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: camera ? QUESTION_CAMERA : false });
    } catch (err) {
      stopMic();
      if (err.name === 'NotAllowedError') throw new Error(camera ? 'Allow camera and microphone access to ask on camera.' : 'Allow microphone access to ask out loud.');
      throw new Error(`Couldn't start the ${camera ? 'camera' : 'microphone'}: ${err.message}`);
    }
    if (!mounted.current) return stopMic();
    const mimeType = (camera ? RECORDING_TYPES : AUDIO_RECORDING_TYPES).find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const chunks = [];
    const rec = (r.recorder = new MediaRecorder(r.stream, camera ? { mimeType, videoBitsPerSecond: 1_500_000 } : { mimeType }));
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stopMic();
      r.recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
      r.take = { blob, url: URL.createObjectURL(blob) };
      transcribe().catch(fail);
    };
    rec.start(1000);
    onBusy(true);
    const started = Date.now();
    setSecs(0);
    r.timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      setSecs(elapsed);
      if (elapsed >= MAX_QUESTION_SECS && rec.state === 'recording') rec.stop();
    }, 250);
    show({ step: 'recording' });
  }
  const stop = () => r.recorder?.state === 'recording' && r.recorder.stop();
  const rerecord = async () => {
    close();
    await record();
  };

  async function transcribe() {
    const current = r.take;
    show({ step: 'transcribing' });
    try {
      const { recording } = await api('POST', `/api/office-hours/${oh.id}/recordings`, current.blob);
      if (r.take !== current) return api('DELETE', `/api/recordings/${recording.id}`).catch(() => {}); // discarded meanwhile
      r.draft = recording;
      setLines(recording.cues.map(([, , text]) => text));
      show({ step: 'review' });
    } catch (err) {
      if (r.take === current) show({ step: 'failed' }); // keep the recording so a failure doesn't lose it
      throw err;
    }
  }

  async function ask() {
    try {
      const { question } = await api('POST', `/api/office-hours/${oh.id}/questions`, { recording: r.draft.id, cues: lines, anonymous });
      r.draft = null; // it's the question's recording now
      close();
      onAsked(question);
    } catch (err) {
      if (err.status === 404) {
        // The draft expired on the server; the recording is still here to transcribe again.
        r.draft = null;
        await transcribe();
        return;
      }
      throw err; // stays on the review, with the corrections, to try again
    }
  }

  const playback = r.take ? camera ? <Video key={r.take.url} src={r.take.url} controls style={take} /> : <AudioPlayer key={r.take.url} src={r.take.url} /> : null;
  const { step } = state;
  if (step === 'idle') {
    return (
      <View style={{ gap: 10 }}>
        <Button kind="primary" title="● Record your question" onPress={record} />
        <Hint>Up to {MAX_QUESTION_SECS} seconds. You'll check the transcript before asking.</Hint>
      </View>
    );
  }
  if (step === 'recording') {
    return (
      <View style={{ gap: 12 }}>
        {camera ? <video ref={preview} autoPlay playsInline muted style={{ ...take, transform: 'scaleX(-1)' }} /> : null}
        <Row gap={10} wrap>
          <View style={styles.recPill}>
            <Text style={styles.recText}>● REC {fmtDuration(secs)}</Text>
          </View>
          <Button kind="primary" title="■ Stop" onPress={stop} />
          <Button title="Cancel" onPress={close} />
        </Row>
      </View>
    );
  }
  if (step === 'transcribing') {
    return (
      <View style={{ gap: 12 }}>
        {playback}
        <Hint>Transcribing your recording…</Hint>
      </View>
    );
  }
  if (step === 'failed') {
    return (
      <View style={{ gap: 12 }}>
        {playback}
        <Row gap={8} wrap>
          <Button kind="primary" title="Try again" onPress={transcribe} />
          <Button title="Re-record" onPress={rerecord} />
          <Button kind="link" title="Discard" onPress={close} />
        </Row>
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {playback}
      <View style={styles.cueEditor}>
        <Hint>Check the transcript: it's your question's text. Fix anything that was misheard. Each line is one subtitle and keeps its timing; clear a line to remove it.</Hint>
        <CueLines cues={r.draft.cues} values={lines} onChange={setLines} />
      </View>
      <Row gap={8} wrap>
        <Button kind="primary" title="Ask" onPress={ask} />
        <Button title="Re-record" onPress={rerecord} />
        <Button kind="link" title="Discard" onPress={close} />
      </Row>
    </View>
  );
}

// A recording, or the camera while recording (mirrored, like a selfie view), filling the shape of the
// top half of the player, as the question will be shown.
const take = { display: 'block', width: '100%', aspectRatio: String(HALF), objectFit: 'cover', background: '#111', borderRadius: 12 };

const styles = StyleSheet.create({
  askInput: { borderWidth: 0, borderBottomWidth: 1, borderColor: color.lineStrong, borderRadius: 0, backgroundColor: 'transparent', paddingHorizontal: 0, fontFamily: font.serif, fontSize: 21, lineHeight: 29, boxShadow: 'none' },
  voicePlay: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  voicePlayText: { fontSize: 12, color: color.ink2 },
  recPill: { backgroundColor: color.accent, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 11 },
  recText: { color: '#fff', fontFamily: font.sans, fontSize: 13, fontWeight: '700', letterSpacing: 0.5, fontVariant: ['tabular-nums'] },
  cueEditor: { gap: 10, padding: 14, borderRadius: radius.sm, backgroundColor: color.surface },
});
