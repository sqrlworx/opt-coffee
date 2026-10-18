// Questions and transcripts as text that follows its recording: the line being spoken is
// highlighted, and tapping a line plays from there. Speech is processed in the background, so text
// that's still on its way is watched until it's ready.
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { fmtDuration } from '../format.js';
import { useWatchQuestion } from '../hooks.js';
import { color, font } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Disclosure, Hint, Label, Row, Small } from '../ui/index.jsx';
import { useMediaTime, usePlaying, Video } from './Video.jsx';

// Transcript cues as text: the cue being spoken is highlighted, and tapping one plays from there.
export function SyncedCues({ mediaRef, cues, style, suffix = null }) {
  const t = useMediaTime(mediaRef);
  return (
    <Text style={style}>
      {cues.map(([start, end, text], i) => (
        <Text key={i}>
          {i ? ' ' : ''}
          <Text
            onPress={() => {
              const media = mediaRef.current;
              if (!media) return;
              media.currentTime = start;
              media.play().catch(() => {});
            }}
            style={[styles.cue, t >= start && t < end && styles.cueActive]}
          >
            {text}
          </Text>
        </Text>
      ))}
      {suffix}
    </Text>
  );
}

// One input per transcript cue, labelled with its start time. Each line is one subtitle and keeps
// its timing; clearing a line removes it.
export function CueLines({ cues, values, onChange }) {
  return (
    <View style={{ gap: 8 }}>
      {cues.map(([start], i) => (
        <Row key={i} gap={10}>
          <Text style={styles.cueTime}>{fmtDuration(start)}</Text>
          <input
            className="native-input"
            value={values[i]}
            maxLength={300}
            aria-label="Transcript line"
            autoFocus={i === 0}
            onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
            style={{ minHeight: 44, padding: '8px 12px' }}
          />
        </Row>
      ))}
    </View>
  );
}

// Corrects transcription mistakes line by line. `save(lines)` stores the corrections and resolves
// with the result, which goes to `done` (null if cancelled).
export function TranscriptEditor({ cues, save, done }) {
  const { toast } = useApp();
  const [values, setValues] = useState(() => cues.map(([, , text]) => text));
  return (
    <View style={styles.editor}>
      <Hint>Fix anything the transcription got wrong. Each line is one subtitle, so it keeps its timing. Clear a line to remove it.</Hint>
      <CueLines cues={cues} values={values} onChange={setValues} />
      <Row gap={8}>
        <Button
          kind="primary"
          small
          title="Save transcript"
          onPress={async () => {
            const result = await save(values);
            toast('Transcript saved', 'success');
            done(result);
          }}
        />
        <Button small title="Cancel" onPress={() => done(null)} />
      </Row>
    </View>
  );
}

const saveAnswerTranscript = async (questionId, lines) => (await api('PUT', `/api/questions/${questionId}/answer-transcript`, { cues: lines })).transcript;

// An answer's transcript, under its video. A pending one is watched until it's ready. `pick` finds
// this answer's transcript in a re-fetched question; `onUpdate` hears about the change. `editable`
// lets the expert correct it.
export function AnswerTranscript({ videoRef, transcript, questionId, pick, onUpdate, editable = false }) {
  const [editing, setEditing] = useState(false);
  useWatchQuestion(questionId, transcript?.status === 'pending', (q) => pick(q)?.status !== 'pending', (q) => onUpdate(pick(q)));
  if (!transcript) return null;
  if (transcript.status === 'pending') return <Hint>Transcribing… captions and a transcript will appear here.</Hint>;
  if (transcript.status === 'failed') return <Hint>This answer couldn't be transcribed.</Hint>;
  if (!transcript.cues.length) return <Hint>No speech was detected in this answer.</Hint>;
  if (editing) {
    return (
      <TranscriptEditor
        cues={transcript.cues}
        save={(lines) => saveAnswerTranscript(questionId, lines)}
        done={(next) => {
          setEditing(false);
          if (next) onUpdate(next);
        }}
      />
    );
  }
  return (
    <Disclosure title={<Label>Transcript{transcript.edited ? ' · edited' : ''}</Label>}>
      <View style={styles.transcriptBox}>
        <SyncedCues mediaRef={videoRef} cues={transcript.cues} style={[styles.body, { fontSize: 15, lineHeight: 26 }]} />
      </View>
      <Row wrap gap={16}>
        <CaptionsLink url={transcript.captions} />
        {editable ? <Button kind="link" small title="Edit transcript" onPress={() => setEditing(true)} /> : null}
      </Row>
    </Disclosure>
  );
}

export function CaptionsLink({ url }) {
  return (
    <a href={url} download="" style={{ color: color.ink2, fontFamily: font.sans, fontSize: 14, minHeight: 32, display: 'inline-flex', alignItems: 'center' }}>
      Download captions (.vtt)
    </a>
  );
}

// A question's text, with a button to play it once there's audio (a typed question's is read aloud
// in the background, so a pending one is watched). A spoken question's text is its transcript, which
// follows along as the recording plays. One asked on camera plays its video instead (it has the
// sound too), shown under the text while it plays. On the page the button only shows on hover;
// phones can't hover, so it's always there.
export function QuestionText({ q, style }) {
  const [audio, setAudio] = useState({ audio: q.audio, audioStatus: q.audioStatus });
  useWatchQuestion(q.id, !audio.audio && audio.audioStatus === 'pending', (x) => x.audioStatus !== 'pending', (x) => setAudio({ audio: x.audio, audioStatus: x.audioStatus }));
  const mediaRef = useRef(null);
  const playing = usePlaying(mediaRef);
  const [seen, setSeen] = useState(false); // the asker's video has a picture to show
  const textStyle = [styles.qBody, style];
  if (!audio.audio) return <Text style={textStyle}>{q.body}</Text>;
  const video = Boolean(q.askerVideo);
  const label = video ? 'Watch the question as it was asked' : q.askedWith === 'audio' ? 'Play the question as it was asked' : 'Listen to the question';
  const button = (
    <Pressable
      role="button"
      aria-label={label}
      hitSlop={8}
      onPress={() => {
        const media = mediaRef.current;
        if (media.paused) media.play().catch(() => {});
        else media.pause();
      }}
      style={[styles.playBtn, playing && { backgroundColor: color.accent }]}
    >
      {playing ? <Text style={{ color: color.accentInk, fontSize: 10, fontWeight: '700' }}>❚❚</Text> : <Icon name={video ? 'video' : 'play'} size={13} color={color.accent} />}
    </Pressable>
  );
  const cues = q.audioTranscript?.cues;
  const text = cues?.length ? <SyncedCues mediaRef={mediaRef} cues={cues} style={textStyle} /> : <Text style={textStyle}>{q.body}</Text>;
  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>{text}</View>
        {button}
      </View>
      {video ? (
        <Video
          ref={mediaRef}
          src={q.askerVideo}
          preload="none"
          firstFrame={false}
          onPlaying={() => setSeen(true)}
          onPause={() => setSeen(false)}
          onClick={() => mediaRef.current.pause()}
          style={{ display: playing && seen ? 'block' : 'none', maxWidth: 360, aspectRatio: '16 / 9', objectFit: 'cover', background: '#111', borderRadius: 12 }}
        />
      ) : (
        <audio ref={mediaRef} src={audio.audio} preload="none" />
      )}
    </View>
  );
}

// An answer's transcript as paragraphs, for the discussion. A take recorded in a session starts with
// the question being played; that part is left out, since the question is written above it.
export function AnswerParagraphs({ question, transcript, onReady }) {
  useWatchQuestion(question.id, transcript?.status === 'pending', (q) => q.transcript?.status !== 'pending', (q) => onReady(q.transcript));
  if (transcript?.status === 'pending') return <Small style={styles.muted}>Transcribing this answer…</Small>;
  if (!transcript || transcript.status === 'failed') return <Small style={styles.muted}>This answer couldn't be transcribed.</Small>;
  const cues = transcript.cues.filter(([start, end]) => (start + end) / 2 >= (question.answerStart ?? 0));
  if (!cues.length) return <Small style={styles.muted}>No speech was detected in this answer.</Small>;
  // A pause of a second or more starts a new paragraph.
  const paragraphs = [[]];
  cues.forEach(([start, , text], i) => {
    if (i && start - cues[i - 1][1] >= 1) paragraphs.push([]);
    paragraphs.at(-1).push(text);
  });
  return paragraphs.map((p, i) => (
    <Text key={i} style={[styles.body, { lineHeight: 26 }]}>
      {p.join(' ')}
    </Text>
  ));
}

const styles = StyleSheet.create({
  body: { fontFamily: font.sans, fontSize: 16, lineHeight: 24, color: color.ink },
  muted: { color: color.muted },
  qBody: { fontFamily: font.serif, fontSize: 20, lineHeight: 28, color: color.ink },
  cue: { borderRadius: 3, cursor: 'pointer' },
  cueActive: { backgroundColor: color.accentSoft },
  cueTime: { width: 42, flexShrink: 0, fontFamily: font.sans, fontSize: 13, color: color.muted, fontVariant: ['tabular-nums'] },
  editor: { gap: 10, padding: 14, borderRadius: 12, backgroundColor: color.surface },
  transcriptBox: { maxHeight: 320, overflowY: 'auto' },
  playBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1, cursor: 'pointer' },
});
