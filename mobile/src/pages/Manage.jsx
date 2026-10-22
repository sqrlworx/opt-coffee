// The planner, where the expert seeds questions, picks the order to answer them in, records the
// answers and publishes them. On the page the moderator's suggested order and the expert's answer
// order sit side by side, and questions are dragged from one to the other; on a phone they're two
// tabs, questions are added with a tap, moved by dragging their grips (manage/useReorder.js), and
// taken out by sliding them left (manage/SwipeRow.jsx).
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, sendFile } from '../api.js';
import { useApp } from '../context.js';
import { fmtDate, fmtDuration } from '../format.js';
import { useBump, useLeaveGuard, useLoad } from '../hooks.js';
import { AnswerActions, AnswerBox } from '../manage/AnswerBox.jsx';
import { createSession } from '../manage/session.js';
import { Studio } from '../manage/Studio.jsx';
import { Suggestions } from '../manage/Suggestions.jsx';
import { SwipeRow } from '../manage/SwipeRow.jsx';
import { useReorder } from '../manage/useReorder.js';
import { QuestionText } from '../media/transcript.jsx';
import { ANSWER_CAMERA } from '../media/Video.jsx';
import { QuestionMeta } from '../officehour/questions.jsx';
import { go } from '../router.js';
import { color, font, MAX_WIDTH, radius, TAB_BAR_HEIGHT } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Chip, Empty, H1, Hint, Loading, Row, Segmented, Small, TopicChip, confirmed } from '../ui/index.jsx';

const MAX_BROLL_UPLOAD = 500_000_000; // bytes, as the server allows

export default function ManagePage({ params }) {
  const { data, error, reload } = useLoad(() => api('GET', `/api/office-hours/${params.id}`), [params.id]);
  const oh = data?.officeHour;
  // Published answers are final, so there's nothing left to plan.
  const away = oh && (!oh.isExpert || oh.status === 'published');
  useEffect(() => {
    if (away) go(`#/oh/${params.id}`);
  }, [away, params.id]);
  if (error && !data) return <Empty message={error.message} />;
  if (!data || away) return <Loading />;
  return <Planner data={data} reload={reload} />;
}

function Planner({ data, reload }) {
  const app = useApp();
  const { toast, fail, requireLogin } = app;
  const oh = data.officeHour;
  const bump = useBump();
  // The planner's state, changed in place as the page's is, with bump() to show it.
  const m = useRef(null);
  if (!m.current) {
    const all = data.groups.flatMap((g) => g.questions);
    m.current = {
      questions: new Map(all.map((q) => [q.id, q])),
      queue: [...data.plan.queue],
      videos: new Map(all.map((q) => [q.id, q.answerVideo])), // draft answer URL per question
      transcripts: new Map(all.map((q) => [q.id, q.answerTranscript])), // and its transcript
      brolls: new Map(all.map((q) => [q.id, q.broll])), // and its b-roll
      uploads: new Map(), // question id -> { blob, url, answerStart, failed } for a take that's saving or failed to save
      uploading: Promise.resolve(), // takes upload one at a time, in the order they were recorded
      finishing: 0, // takes kept but still being finished by the browser, about to start saving
      local: new Map(), // question id -> object URL of its saved take, to keep playing from
      brollDrafts: new Map(), // question id -> b-roll description being typed, while its box is open
      brollChanging: new Set(), // question ids whose b-roll is being changed: making or uploading another is offered
      brollUploads: new Map(), // question id -> { name, sent (0 to 1), stop } for a video being uploaded
      // The answer order saves itself whenever it changes, so leaving or refreshing never loses it.
      edits: 0,
      savedEdits: 0,
      saving: Promise.resolve(),
      saveFailed: false,
      savedAt: null,
    };
  }
  const s = m.current;
  // Reloaded (after seeding questions, or closing them): new questions join the plan, and the rest
  // pick up their votes. What's been recorded here stays as it is.
  const seen = useRef(data);
  if (seen.current !== data) {
    seen.current = data;
    for (const q of data.groups.flatMap((g) => g.questions)) {
      if (!s.questions.has(q.id)) {
        s.videos.set(q.id, q.answerVideo);
        s.transcripts.set(q.id, q.answerTranscript);
        s.brolls.set(q.id, q.broll);
      }
      s.questions.set(q.id, q);
    }
  }
  const [tab, setTab] = useState(s.queue.length ? 'order' : 'questions');
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;

  useLeaveGuard(s.savedEdits < s.edits || Boolean(session) || s.finishing > 0 || s.uploads.size > 0 || s.brollUploads.size > 0);
  useEffect(
    () => () => {
      sessionRef.current?.close();
      s.local.forEach((url) => URL.revokeObjectURL(url));
    },
    [s],
  );

  // Saves the answer order as it is now, after any save already under way.
  function save() {
    const run = s.saving.catch(() => {}).then(async () => {
      const upTo = s.edits;
      try {
        await api('PUT', `/api/office-hours/${oh.id}/plan`, { items: s.queue.map((qid) => ({ questionId: qid })) });
      } catch (err) {
        s.saveFailed = true;
        bump();
        throw err;
      }
      s.saveFailed = false;
      s.savedEdits = Math.max(s.savedEdits, upTo);
      s.savedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      bump();
    });
    s.saving = run;
    return run;
  }
  const setQueue = (queue) => {
    s.queue = queue;
    s.edits += 1;
    bump();
    save().catch((err) => (err.status === 401 ? requireLogin() : toast(`Couldn't save your answer order: ${err.message}`, 'error')));
  };

  function keepLocal(qid, url) {
    if (s.local.has(qid) && s.local.get(qid) !== url) URL.revokeObjectURL(s.local.get(qid));
    if (url) s.local.set(qid, url);
    else s.local.delete(qid);
  }

  // Saves a take as the question's answer, in the background.
  function upload(qid, take) {
    const previous = s.uploads.get(qid);
    if (previous && previous.url !== take.url) URL.revokeObjectURL(previous.url);
    s.uploads.set(qid, take);
    bump();
    s.uploading = s.uploading.catch(() => {}).then(async () => {
      if (s.uploads.get(qid) !== take) return; // a newer take replaced it
      const query = take.answerStart != null ? `?answerStart=${take.answerStart.toFixed(2)}` : '';
      try {
        const res = await api('PUT', `/api/questions/${qid}/video${query}`, take.blob);
        if (s.uploads.get(qid) !== take) return;
        s.uploads.delete(qid);
        keepLocal(qid, take.url);
        s.videos.set(qid, res.video);
        s.transcripts.set(qid, res.transcript);
        s.brolls.set(qid, res.broll); // its b-roll moves to where it fits in the new take
      } catch (err) {
        if (s.uploads.get(qid) !== take) return;
        if (err.status === 401) return requireLogin();
        take.failed = true; // kept on the phone so a failed upload doesn't lose it
        toast(`Couldn't save your answer to question ${s.queue.indexOf(qid) + 1}: ${err.message}`, 'error');
      }
      bump();
    });
  }

  const hasAnswer = (qid) => Boolean(s.videos.get(qid) || s.uploads.has(qid));

  // Starts a session at `qid` and carries on down the answer order from there.
  async function startSession(qid) {
    const n = s.queue.indexOf(qid) + 1;
    if (hasAnswer(qid) && !confirmed(`Question ${n} already has a recorded answer. If you answer it again, the new answer replaces it.\n\nStart here anyway?`)) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      throw new Error("This browser can't record video. Try a recent Chrome, Firefox or Safari.");
    }
    let camera;
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: ANSWER_CAMERA, audio: true });
    } catch (err) {
      throw new Error(err.name === 'NotAllowedError' ? 'Allow camera and microphone access to record your answers.' : `Couldn't start the camera: ${err.message}`);
    }
    const created = createSession({
      order: s.queue.slice(n - 1),
      camera,
      questions: s.questions,
      keep: upload,
      finishing: (delta) => ((s.finishing += delta), bump()),
      toast,
      changed: bump,
      closed: () => setSession((current) => (current === created ? null : current)),
    });
    setSession(created);
  }

  const plan = {
    m: s,
    bump,
    upload,
    startSession: (qid) => startSession(qid),
    discardUpload(qid) {
      URL.revokeObjectURL(s.uploads.get(qid).url);
      s.uploads.delete(qid);
      bump();
    },
    async removeAnswer(qid) {
      if (!confirmed('Delete this recorded answer?')) return;
      const res = await api('DELETE', `/api/questions/${qid}/video`);
      keepLocal(qid, null);
      s.videos.set(qid, null);
      s.transcripts.set(qid, null);
      s.brolls.set(qid, res.broll); // kept for the next take
      bump();
    },
    setBroll(qid, broll) {
      s.brolls.set(qid, broll);
      bump();
    },
    // Uploads a video the expert picked as a question's b-roll. The server then gets it ready, in
    // a few seconds, and places it, by its file's name for want of a description.
    async uploadBroll(qid, file) {
      if (file.type && !file.type.startsWith('video/')) return toast('Choose a video file.', 'error');
      if (file.size > MAX_BROLL_UPLOAD) return toast('That video is too large: b-roll can be up to 500 MB. Trim it, or export it smaller.', 'error');
      const up = { name: file.name, sent: 0, stop: new AbortController() };
      s.brollUploads.set(qid, up);
      bump();
      const query = new URLSearchParams({ name: file.name });
      try {
        const res = await sendFile('PUT', `/api/questions/${qid}/broll/video?${query}`, file, {
          signal: up.stop.signal,
          progress: (sent) => {
            up.sent = sent;
            bump();
          },
        });
        s.brollDrafts.delete(qid);
        s.brollChanging.delete(qid);
        s.brolls.set(qid, res.broll);
        if (res.trimmed) toast(`Your video is ${fmtDuration(res.trimmed.from)} long, and b-roll can be up to ${fmtDuration(res.trimmed.to)}, so its start is used.`);
      } catch (err) {
        if (err.status === 401) requireLogin();
        else if (err.name !== 'AbortError') toast(`Couldn't add your video: ${err.message}`, 'error');
      } finally {
        s.brollUploads.delete(qid);
        bump();
      }
    },
  };

  async function publish() {
    if (s.finishing || s.uploads.size) throw new Error('Wait for your answers to finish saving (or discard any that failed) before publishing.');
    if (s.brollUploads.size) throw new Error('Wait for your b-roll to finish uploading before publishing.');
    const making = s.queue.find((qid) => s.videos.get(qid) && s.brolls.get(qid)?.status === 'pending');
    if (making) throw new Error(`The b-roll for question ${s.queue.indexOf(making) + 1} is still being made. Wait for it, or remove it, before publishing.`);
    const answered = s.queue.filter((qid) => s.videos.get(qid)).length;
    const unanswered = s.queue.length - answered;
    const note = unanswered ? `\n\n${unanswered} queued question(s) have no recorded answer and will be left out.` : '';
    if (!confirmed(`Publish ${answered} answer(s)? Subscribers will see them in their feed.${note}\n\nThis is final: you won't be able to re-record, remove or reorder answers afterwards.`)) return;
    await save();
    await api('POST', `/api/office-hours/${oh.id}/publish`);
    s.edits = s.savedEdits; // nothing left to lose
    toast('Published!', 'success');
    go(`#/oh/${oh.id}`);
  }

  let saveState = '';
  if (s.saveFailed) saveState = "Couldn't save your answer order";
  else if (s.savedEdits < s.edits) saveState = 'Saving…';
  else if (s.savedAt) saveState = `Draft saved ${s.savedAt}`;
  const savingTakes = [...s.uploads.values()].filter((t) => !t.failed).length;

  return (
    <View style={{ gap: 32, paddingBottom: 72 }}>
      <View style={{ gap: 14 }}>
        <Row gap={14} style={{ justifyContent: 'space-between' }}>
          <View style={{ flexShrink: 1 }}>
            <TopicChip oh={oh} accent link={false} />
          </View>
          <Button small title="View public page" onPress={() => go(`#/oh/${oh.id}`)} />
        </Row>
        <H1 style={{ fontSize: 38, lineHeight: 40, letterSpacing: -1 }}>{oh.title}</H1>
        <Small style={{ color: color.muted }}>
          Answers expected {fmtDate(oh.answersExpectedAt)}
          {'\n'}moderator: {data.moderator}
        </Small>
        {oh.status === 'open' ? (
          <Button
            title="Close questions now"
            style={{ alignSelf: 'flex-start' }}
            onPress={async () => {
              if (!confirmed('Stop accepting questions and votes now?')) return;
              await api('POST', `/api/office-hours/${oh.id}/close`);
              reload();
            }}
          />
        ) : null}
      </View>
      {oh.status === 'open' ? <Suggestions oh={oh} onAdded={reload} /> : null}
      <View style={{ gap: 18 }}>
        <View style={styles.tabs}>
          <Segmented
            label="Lists"
            stretch
            value={tab}
            onChange={setTab}
            options={[
              ['questions', 'Suggested order'],
              ['order', `Answer order${s.queue.length ? ` · ${s.queue.length}` : ''}`],
            ]}
          />
        </View>
        {tab === 'questions' ? suggestedOrder() : <AnswerOrder plan={plan} setQueue={setQueue} />}
      </View>
      <View id="savebar" style={styles.savebar}>
        <View style={styles.savebarInner}>
          <Small style={{ color: color.muted, flex: 1 }} numberOfLines={2}>
            {saveState}
          </Small>
          <Button kind="primary" title="Publish answers" onPress={publish} />
        </View>
      </View>
      {session ? <Studio session={session} questions={s.questions} queue={s.queue} hasAnswer={hasAnswer} saving={savingTakes} /> : null}
    </View>
  );

  // The moderator's mix of popularity and topic flow, similar questions grouped. A tap adds one to
  // the answer order.
  function suggestedOrder() {
    const { queue } = s;
    const queued = new Set(queue);
    return (
      <View style={{ gap: 14 }}>
        <Hint>Moderator mix of popularity and topic flow; similar questions grouped. Add them to your answer order one by one, or use it wholesale.</Hint>
        <Button
          title="Use suggested order"
          disabled={s.questions.size === 0}
          onPress={() => {
            if (queue.length && !confirmed('Replace your current answer order with the suggested order?')) return;
            setQueue([...data.plan.suggestedOrder]);
            setTab('order');
          }}
        />
        {data.groups.length === 0 ? <Empty message="No questions yet." /> : null}
        {data.groups.map((g, gi) => (
          <View key={g.label + gi} style={styles.group}>
            <Row gap={12} style={{ alignItems: 'baseline' }}>
              <Text style={styles.groupNum}>{String(gi + 1).padStart(2, '0')}</Text>
              <Text style={styles.groupLabel}>{g.label}</Text>
              <Small style={{ color: color.muted }}>{g.popularity} interest</Small>
            </Row>
            {g.questions.map((q, i) => (
              <View key={q.id} style={[styles.planQ, i === 0 && { borderTopWidth: 0 }, queued.has(q.id) && { opacity: 0.55 }]}>
                <Text style={styles.planVotes}>▲ {q.votes}</Text>
                <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
                  <Text style={styles.planBody}>{q.body}</Text>
                  <QuestionMeta q={q} />
                </View>
                {queued.has(q.id) ? (
                  <Chip>#{queue.indexOf(q.id) + 1}</Chip>
                ) : (
                  <Button small title="Add" onPress={() => setQueue([...queue, q.id])} />
                )}
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
}

// The expert's answer order: what gets published, in this order, if it has a recorded answer. While
// a card is being moved they all fold to their questions, hiding the rest without unmounting it. A
// card slid left shows Remove, which takes it out of the answer order.
function AnswerOrder({ plan, setQueue }) {
  const { m } = plan;
  const { queue } = m;
  const { held, list, handle } = useReorder(queue, setQueue, bars);
  const folded = held != null;
  const [open, setOpen] = useState(null); // the card slid open
  useEffect(() => {
    if (folded) setOpen(null);
  }, [folded]);
  const shown = folded ? null : open;
  return (
    <View style={{ gap: 14 }}>
      <Hint>Drag to reorder. Only questions here with a recorded answer get published, in this order.</Hint>
      {/* From the top; "Answer from here" on a question starts anywhere else. */}
      <Button kind="primary" title="● Start answering" disabled={queue.length === 0} onPress={() => plan.startSession(queue[0])} />
      {queue.length === 0 ? (
        <Empty message="Add questions from the suggested order, or use it wholesale." />
      ) : (
        <View ref={list} style={{ gap: 14 }}>
          {queue.map((qid, i) => {
            const q = m.questions.get(qid);
            const grip = handle(qid, i);
            return (
              <SwipeRow
                key={qid}
                open={shown === qid}
                others={shown != null && shown !== qid}
                setOpen={(on) => setOpen(on ? qid : null)}
                title="Remove"
                label={`Remove question ${i + 1} from the answer order`}
                onAction={() => (setOpen(null), setQueue(queue.filter((id) => id !== qid)))}
              >
                <View style={styles.queueItem}>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    <Text style={styles.queueNum}>{i + 1}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      {folded ? (
                        <Text numberOfLines={2} style={styles.folded}>
                          {q.body}
                        </Text>
                      ) : null}
                      <View style={folded && styles.gone}>
                        <QuestionText q={q} meta={<QuestionMeta q={q} />} style={{ fontSize: 18, lineHeight: 25 }} />
                      </View>
                    </View>
                  </View>
                  {m.videos.get(qid) || m.uploads.has(qid) ? (
                    <View style={folded && styles.gone}>
                      <AnswerBox qid={qid} plan={plan} />
                    </View>
                  ) : null}
                  {/* The grip leads the buttons, and stays while the cards are folded. Its dots line up
                      with the number, the rest of it out in the card's padding. */}
                  <Row wrap gap={8}>
                    <div {...grip} style={{ ...grip.style, marginLeft: -12 }}>
                      <Icon name="grip" size={20} color={color.muted} />
                    </div>
                    {folded ? null : <AnswerActions qid={qid} plan={plan} />}
                  </Row>
                </View>
              </SwipeRow>
            );
          })}
        </View>
      )}
    </View>
  );
}

// Where the top bar and the save bar end on screen: the page scrolls under them.
const bars = () => [document.getElementById('topbar')?.getBoundingClientRect().bottom ?? 0, document.getElementById('savebar')?.getBoundingClientRect().top ?? window.innerHeight];

const styles = StyleSheet.create({
  tabs: { paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: color.ink },
  group: { backgroundColor: color.raised, borderRadius: radius.lg, padding: 18, gap: 6 },
  groupNum: { fontFamily: font.serif, fontSize: 22, color: color.accent, fontVariant: ['lining-nums', 'tabular-nums'] },
  groupLabel: { flex: 1, fontFamily: font.serif, fontSize: 20, lineHeight: 25, color: color.ink },
  planQ: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 12, borderTopWidth: 1, borderTopColor: color.line },
  planVotes: { width: 40, paddingTop: 3, fontFamily: font.sans, fontSize: 13, color: color.muted, fontVariant: ['tabular-nums'] },
  planBody: { fontFamily: font.serif, fontSize: 18, lineHeight: 25, color: color.ink },
  queueItem: { backgroundColor: color.raised, borderRadius: radius.lg, padding: 16, gap: 12 },
  queueNum: { minWidth: 22, fontFamily: font.serif, fontSize: 20, lineHeight: 26, color: color.ink, fontVariant: ['lining-nums', 'tabular-nums'] },
  folded: { fontFamily: font.serif, fontSize: 18, lineHeight: 25, color: color.ink },
  gone: { display: 'none' },
  savebar: { position: 'fixed', left: 0, right: 0, bottom: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`, zIndex: 15, backgroundColor: 'rgba(248,246,242,0.94)', backdropFilter: 'blur(14px)', borderTopWidth: 1, borderTopColor: color.line },
  savebarInner: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10 },
});
