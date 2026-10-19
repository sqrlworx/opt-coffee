import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { go } from '../router.js';
import { Button, Card, Field, H1, Muted } from '../ui/index.jsx';

export default function LoginPage({ query }) {
  const { loadMe, fail } = useApp();
  const next = query.get('next') || '#/';
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ username: '', displayName: '', password: '' });
  const set = (key) => (value) => setF((old) => ({ ...old, [key]: value }));
  const submit = async () => {
    await api('POST', `/api/auth/${mode}`, f);
    await loadMe();
    go(next);
  };
  return (
    <View style={{ gap: 20 }}>
      <H1>Welcome to off hours</H1>
      <Muted>Ask experts questions. Host your own office hours.</Muted>
      <Card style={{ gap: 18 }}>
        <Field label="Username" value={f.username} onChangeText={set('username')} autoComplete="username" autoCapitalize="none" autoCorrect={false} maxLength={30} />
        {mode === 'register' ? <Field label="Display name" value={f.displayName} onChangeText={set('displayName')} autoComplete="name" maxLength={60} /> : null}
        <Field label="Password" value={f.password} onChangeText={set('password')} secureTextEntry autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onSubmitEditing={() => submit().catch(fail)} />
        <Button kind="primary" title={mode === 'login' ? 'Log in' : 'Create account'} onPress={submit} />
        <Button kind="link" title={mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'} onPress={() => setMode(mode === 'login' ? 'register' : 'login')} style={{ alignSelf: 'center' }} />
      </Card>
    </View>
  );
}
