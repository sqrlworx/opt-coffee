// The moderator suggests seed questions from the expert's bio, expertise and topic. The expert
// ticks the ones to post; they appear as "Suggested by moderator" and can be +1'd like any question.
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { color } from '../theme.js';
import { Button, Card, Checkbox, H3, Hint, Small } from '../ui/index.jsx';

export function Suggestions({ oh, onAdded }) {
  const { toast } = useApp();
  const [round, setRound] = useState(0);
  const [items, setItems] = useState([]); // [{ text, on }]
  const [thinking, setThinking] = useState(false);
  const more = async () => {
    setThinking(true);
    try {
      const { questions } = await api('POST', `/api/office-hours/${oh.id}/suggestions`, { round, exclude: items.map((i) => i.text) });
      setRound(round + 1);
      setItems((list) => [...list, ...questions.map((text) => ({ text, on: true }))]);
      if (!questions.length) toast('The moderator is out of ideas — try adding expertise to your profile', 'info');
    } finally {
      setThinking(false);
    }
  };
  const add = async () => {
    const picked = items.filter((i) => i.on).map((i) => i.text);
    if (!picked.length) return toast('Select at least one question');
    await api('POST', `/api/office-hours/${oh.id}/seed`, { questions: picked });
    toast(`Added ${picked.length} seed question${picked.length === 1 ? '' : 's'}`, 'success');
    setItems([]);
    onAdded();
  };
  return (
    <Card style={{ gap: 14 }}>
      <H3>✦ Seed your office hours</H3>
      <Hint>The moderator suggests questions from your bio, expertise and topic. Seeds appear as "Suggested by moderator" and can be +1'd like any question.</Hint>
      <Button title="Suggest questions" onPress={more} />
      {thinking ? <Small style={{ color: color.muted }}>Moderator is thinking…</Small> : null}
      {items.length ? (
        <View>
          {items.map((item, i) => (
            <Checkbox
              key={item.text}
              checked={item.on}
              onChange={(on) => setItems((list) => list.map((x, j) => (j === i ? { ...x, on } : x)))}
              label={item.text}
              style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line, alignItems: 'flex-start' }}
            />
          ))}
        </View>
      ) : null}
      {items.length ? <Button kind="primary" title="Add selected to office hours" onPress={add} /> : null}
    </Card>
  );
}
