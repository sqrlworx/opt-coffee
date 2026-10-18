// Announcing office hours. With `?followUp=<id>`, a follow-up to one of the expert's published
// office hours: its details are filled in, and questions the moderator took from its discussion can
// be picked (and reworded) to start the new one with, as seed questions.
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { toLocalInput } from '../format.js';
import { useLoad } from '../hooks.js';
import { go } from '../router.js';
import { color } from '../theme.js';
import { Button, Card, Checkbox, DateTimeField, Empty, Field, H1, Hint, Link, Loading, Notice, Small, T } from '../ui/index.jsx';

export default function NewOfficeHourPage({ query }) {
  const followUpId = query.get('followUp');
  const { data, error } = useLoad(async () => (followUpId ? (await api('GET', `/api/office-hours/${encodeURIComponent(followUpId)}/follow-up`)).followUp : null), [followUpId]);
  if (error) return <Empty message={error.message} />;
  if (followUpId && !data) return <Loading />;
  return <OfficeHourForm followUp={data} />;
}

function OfficeHourForm({ followUp }) {
  const { me, toast } = useApp();
  const [f, setF] = useState(() => {
    const deadline = new Date(Date.now() + 3 * 86400_000);
    deadline.setHours(17, 0, 0, 0);
    const answers = new Date(deadline.getTime() + 2 * 86400_000);
    return {
      title: followUp?.title ?? '',
      topic: followUp?.topic ?? '',
      description: followUp?.description ?? '',
      deadline: toLocalInput(deadline),
      answers: toLocalInput(answers),
      anon: Boolean(followUp?.allowAnonymous),
    };
  });
  const [picks, setPicks] = useState(() => (followUp?.questions ?? []).map((text) => ({ on: true, text })));
  const set = (key) => (value) => setF((old) => ({ ...old, [key]: value }));
  const setPick = (i, change) => setPicks((list) => list.map((p, j) => (j === i ? { ...p, ...change } : p)));

  const submit = async () => {
    const { officeHour } = await api('POST', '/api/office-hours', {
      title: f.title,
      topic: f.topic,
      description: f.description,
      questionsDeadline: new Date(f.deadline).toISOString(),
      answersExpectedAt: new Date(f.answers).toISOString(),
      allowAnonymous: f.anon,
      followUpOf: followUp?.followUpOf.id,
      questions: followUp ? picks.filter((p) => p.on && p.text.trim()).map((p) => p.text) : undefined,
    });
    toast('Announced! Your subscribers will see it in their feed.', 'success');
    go(`#/oh/${officeHour.id}/manage`);
  };

  return (
    <View style={{ gap: 20 }}>
      <H1>{followUp ? 'Follow-up Q&A' : 'Host office hours'}</H1>
      <Card style={{ gap: 18 }}>
        {followUp ? (
          <Small style={{ color: color.muted }}>
            Follows up on <Link to={`#/oh/${followUp.followUpOf.id}`}>{followUp.followUpOf.title}</Link>
          </Small>
        ) : null}
        <Field label="Title" value={f.title} onChangeText={set('title')} maxLength={120} placeholder="e.g. Ask me anything about breaking into product design" />
        <Field label="Topic" value={f.topic} onChangeText={set('topic')} maxLength={60} placeholder="Optional — e.g. Career growth" />
        <Field label="Description" value={f.description} onChangeText={set('description')} multiline rows={followUp ? 5 : 3} maxLength={2000} placeholder="What should people ask about? Anything off-limits?" />
        <DateTimeField label="Questions due by" value={f.deadline} onChange={set('deadline')} hint="Askers can submit and +1 until then." />
        <DateTimeField label="Answers expected" value={f.answers} onChange={set('answers')} hint="Lets people know when to check back. Not enforced." />
        <Checkbox checked={f.anon} onChange={set('anon')} label="Allow anonymous questions" />
        {followUp ? (
          <View style={{ gap: 10 }}>
            <T style={{ fontWeight: '600', color: color.ink2 }}>Questions from the discussion</T>
            {picks.length ? (
              <>
                <Hint>Ticked questions start the follow-up as suggested questions, which people can +1. Reword them as you like.</Hint>
                {picks.map((p, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingTop: 10, borderTopWidth: 1, borderTopColor: color.line }}>
                    <Checkbox checked={p.on} onChange={(on) => setPick(i, { on })} label={null} style={{ minHeight: 48 }} />
                    <Field style={{ flex: 1 }} value={p.text} onChangeText={(text) => setPick(i, { text })} multiline rows={2} maxLength={500} aria-label="Question" />
                  </View>
                ))}
              </>
            ) : (
              <Hint>The discussion didn’t raise any questions to pick up. You can still ask the moderator for seed questions once it’s announced.</Hint>
            )}
          </View>
        ) : null}
        {me.expertise.length === 0 ? (
          <Notice>
            Tip: <Link to={`#/u/${me.username}`}>add your expertise and bio</Link> so the moderator can suggest better seed questions.
          </Notice>
        ) : null}
        <Button kind="primary" title="Announce office hours" onPress={submit} />
      </Card>
    </View>
  );
}
