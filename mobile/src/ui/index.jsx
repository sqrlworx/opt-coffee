// The building blocks of every screen, in React Native: text, buttons, fields, chips, sheets. Sized
// for fingers (44-point targets) and set like the page: serif headings, hairlines, one accent.
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApp } from '../context.js';
import { countdownParts, fmtDate, relative } from '../format.js';
import { useMounted, useNow } from '../hooks.js';
import { go } from '../router.js';
import { color, font, radius, TOUCH } from '../theme.js';

// ---------- text ----------

export const T = ({ style, ...props }) => <Text style={[s.body, style]} {...props} />;
export const Muted = ({ style, ...props }) => <Text style={[s.body, s.muted, style]} {...props} />;
export const Small = ({ style, ...props }) => <Text style={[s.body, s.small, style]} {...props} />;
export const Serif = ({ style, ...props }) => <Text style={[s.serif, style]} {...props} />;
// Small capitals over a fact or a section: "QUESTIONS OPEN".
export const Label = ({ style, ...props }) => <Text style={[s.label, style]} {...props} />;
export const H1 = ({ style, ...props }) => <Text role="heading" aria-level={1} style={[s.serif, s.h1, style]} {...props} />;
export const H2 = ({ style, ...props }) => <Text role="heading" aria-level={2} style={[s.serif, s.h2, style]} {...props} />;
export const H3 = ({ style, ...props }) => <Text role="heading" aria-level={3} style={[s.serif, s.h3, style]} {...props} />;

// A section's heading, on a rule that starts what it heads.
export function SectionTitle({ children, aside }) {
  return (
    <View style={s.sectionTitle}>
      <H2 style={{ flexShrink: 1 }}>{children}</H2>
      {aside ? <Small style={[s.muted, { flexShrink: 1, textAlign: 'right' }]}>{aside}</Small> : null}
    </View>
  );
}

// A link to a page in the app, as text.
export function Link({ to, style, children, ...props }) {
  return (
    <Text role="link" href={`#${to.replace(/^#/, '')}`} onPress={(e) => (e.preventDefault?.(), go(to))} style={[s.link, style]} {...props}>
      {children}
    </Text>
  );
}

export const UserLink = ({ user, style }) => (
  <Link to={`#/u/${user.username}`} style={[{ textDecorationLine: 'none' }, style]}>
    {user.displayName}
  </Link>
);

// ---------- layout ----------

export const Row = ({ style, gap = 8, wrap = false, ...props }) => <View style={[s.row, { gap }, wrap && s.wrap, style]} {...props} />;
export const Stack = ({ style, gap = 16, ...props }) => <View style={[{ gap }, style]} {...props} />;
export const Card = ({ style, ...props }) => <View style={[s.card, style]} {...props} />;
export const Rule = ({ strong = false, style }) => <View style={[s.rule, strong && { backgroundColor: color.ink }, style]} />;

export function Notice({ children, style }) {
  return (
    <View style={[s.notice, style]}>
      <T style={{ color: color.ink2, fontSize: 15 }}>{children}</T>
    </View>
  );
}

export function Warn({ children }) {
  return (
    <View style={s.warn}>
      <Small style={{ color: color.ink2 }}>⚠ {children}</Small>
    </View>
  );
}

export function Hint({ children, style }) {
  return <Small style={[s.muted, { fontSize: 13 }, style]}>{children}</Small>;
}

export function Empty({ message, children }) {
  return (
    <View style={s.empty}>
      <Serif style={s.emptyText}>{message}</Serif>
      {children}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ paddingVertical: 64, alignItems: 'center' }}>
      <Serif style={[s.emptyText, { fontSize: 18 }]}>Loading…</Serif>
    </View>
  );
}

// A section that opens and closes, like <details>.
export function Disclosure({ title, children, initiallyOpen = false, style, titleStyle }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={style}>
      <Pressable onPress={() => setOpen(!open)} aria-expanded={open} role="button" style={s.disclosure}>
        <Text style={[s.disclosureMark, open && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
        <View style={{ flex: 1 }}>{typeof title === 'string' ? <Text style={[s.body, { fontWeight: '600' }, titleStyle]}>{title}</Text> : title}</View>
      </Pressable>
      {open ? <View style={{ gap: 10, paddingTop: 4 }}>{children}</View> : null}
    </View>
  );
}

// ---------- buttons ----------

// `onPress` may return a promise: the button waits for it, disabled, and shows what went wrong if
// it fails. `kind` is primary (ink), soft (the default), ring (outlined), or link.
export function Button({ title, onPress, kind = 'soft', small = false, disabled = false, icon = null, style, textStyle, label, grow = false }) {
  const { fail } = useApp();
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const press = async () => {
    let result;
    try {
      result = onPress?.();
      if (!result?.then) return;
      setBusy(true);
      await result;
    } catch (err) {
      fail(err);
    } finally {
      if (result?.then && mounted.current) setBusy(false);
    }
  };
  const off = disabled || busy;
  if (kind === 'link') {
    return (
      <Pressable onPress={press} disabled={off} role="button" aria-label={label} hitSlop={10} style={[{ minHeight: 32, justifyContent: 'center' }, off && { opacity: 0.45 }, style]}>
        <Text style={[s.body, s.link, small && s.small, textStyle]}>{title}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={press}
      disabled={off}
      role="button"
      aria-label={label}
      aria-busy={busy}
      style={({ pressed, hovered }) => [
        s.btn,
        small && s.btnSmall,
        kind === 'primary' && s.btnPrimary,
        kind === 'ring' && s.btnRing,
        hovered && !off && (kind === 'primary' ? { backgroundColor: '#38332d' } : { backgroundColor: color.surface2 }),
        pressed && !off && { transform: [{ translateY: 1 }] },
        off && { opacity: 0.45 },
        grow && { flexGrow: 1 },
        style,
      ]}
    >
      {icon}
      {title != null ? <Text style={[s.btnText, small && s.btnTextSmall, kind === 'primary' && { color: color.paper }, textStyle]} numberOfLines={1}>{title}</Text> : null}
    </Pressable>
  );
}

// A row of options, one picked: "Type · Speak · Video". `stretch` spreads them across the screen,
// each as wide as the others.
export function Segmented({ options, value, onChange, label, stretch = false }) {
  return (
    <View role="radiogroup" aria-label={label} style={[s.segmented, stretch && { alignSelf: 'stretch' }]}>
      {options.map(([key, text]) => (
        <Pressable key={key} role="radio" aria-checked={key === value} onPress={() => onChange(key)} style={[s.segment, stretch && { flex: 1, alignItems: 'center', paddingHorizontal: 8 }, key === value && s.segmentOn]}>
          <Text numberOfLines={1} style={[s.segmentText, key === value && { color: color.ink }]}>{text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---------- fields ----------

export function Field({ label, hint, style, inputStyle, multiline = false, rows = 3, ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ gap: 6 }, style]}>
      {label ? <Text style={s.fieldLabel}>{label}</Text> : null}
      <TextInput
        multiline={multiline}
        numberOfLines={multiline ? rows : undefined}
        placeholderTextColor={color.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[s.input, multiline && { minHeight: 24 * rows + 24, textAlignVertical: 'top' }, focused && s.inputFocused, inputStyle]}
        {...props}
      />
      {hint ? <Hint>{hint}</Hint> : null}
    </View>
  );
}

// A date and time, with the phone's own picker (React Native Web has no date input of its own).
export function DateTimeField({ label, hint, value, onChange }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <input className="native-input" type="datetime-local" required value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      {hint ? <Hint>{hint}</Hint> : null}
    </View>
  );
}

export function Checkbox({ checked, onChange, label, children, style, disabled = false }) {
  return (
    <Pressable role="checkbox" aria-checked={checked} aria-label={typeof label === 'string' ? label : undefined} disabled={disabled} onPress={() => onChange(!checked)} style={[s.check, style]}>
      <View style={[s.box, checked && s.boxOn]}>{checked ? <Text style={s.tick}>✓</Text> : null}</View>
      {label != null ? <Text style={[s.body, { color: color.ink2, flex: 1 }]}>{label}</Text> : null}
      {children}
    </Pressable>
  );
}

// ---------- chips, badges, tags ----------

export function Chip({ children, muted = false, accent = false }) {
  return (
    <View style={[s.chip, accent && { backgroundColor: 'transparent', paddingHorizontal: 0 }]}>
      <Text style={[s.chipText, muted && { color: color.muted }, accent && s.chipAccent]}>{children}</Text>
    </View>
  );
}

export const TopicChip = ({ oh, accent }) => (oh.topic ? <Chip accent={accent}>{oh.topic}</Chip> : <Chip muted accent={accent}>Open topic</Chip>);

// Status reads as text with a dot: the accent while questions are open, a ring once they've closed.
export function StatusBadge({ oh }) {
  useNow(60_000);
  let text;
  let kind = 'closed';
  if (oh.status === 'open') [text, kind] = [`Taking questions · closes ${relative(oh.questionsDeadline)}`, 'open'];
  else if (oh.status === 'closed') text = `Questions closed · answers expected ${fmtDate(oh.answersExpectedAt)}`;
  else if (oh.processing) text = 'Published · preparing the video';
  else [text, kind] = [`Answered ${relative(oh.publishedAt)}`, 'published'];
  return (
    <View style={s.badge}>
      <View style={[s.dot, kind === 'open' && s.dotOpen, kind === 'closed' && s.dotClosed]} />
      <Text style={[s.badgeText, kind === 'closed' && { color: color.muted }]}>{text}</Text>
    </View>
  );
}

export function Tag({ children, you = false, mod = false, expert = false }) {
  return <Text style={[s.tag, you && s.tagYou, mod && { color: color.ink2 }, expert && s.tagExpert]}>{children}</Text>;
}

export function Avatar({ name, size = 40 }) {
  return (
    <View style={[s.avatar, { width: size, height: size }]}>
      <Text style={[s.serif, { fontSize: size * 0.45, lineHeight: size }]}>{name.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

// The time left until `deadline`, as 2d 05h 09m 30s, ticking down each second.
export function Countdown({ deadline, style }) {
  useNow(1000);
  const parts = countdownParts(new Date(deadline).getTime());
  if (!parts.length) return <Serif style={style}>Closed</Serif>;
  return (
    <Serif role="timer" style={[{ fontVariant: ['lining-nums', 'tabular-nums'] }, style]}>
      {parts.map(([n, unit], i) => (
        <Text key={unit}>
          {i ? ' ' : ''}
          {n}
          <Text style={s.cdUnit}>{unit}</Text>
        </Text>
      ))}
    </Serif>
  );
}

// ---------- sheets ----------

// A panel that slides up from the bottom, over a dimmed page; tapping outside closes it.
export function Sheet({ visible, onClose, title, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.sheetWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} aria-label="Close" />
        <View style={s.sheet} role="dialog" aria-label={title}>
          <View style={s.grabber} />
          <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Asks before something that can't be undone, in the phone's own dialog.
export const confirmed = (message) => window.confirm(message);

// Renders `children` once the page has been on screen a moment (to skip a flash of a slow state).
export function Delayed({ ms = 300, children }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown ? children : null;
}

export const s = StyleSheet.create({
  body: { fontFamily: font.sans, fontSize: 16, lineHeight: 24, color: color.ink },
  muted: { color: color.muted },
  small: { fontSize: 14, lineHeight: 20 },
  serif: { fontFamily: font.serif, color: color.ink, fontWeight: '400' },
  h1: { fontSize: 40, lineHeight: 42, letterSpacing: -0.8 },
  h2: { fontSize: 27, lineHeight: 31, letterSpacing: -0.3 },
  h3: { fontSize: 21, lineHeight: 26 },
  label: { fontFamily: font.sans, fontSize: 11, lineHeight: 16, fontWeight: '600', color: color.muted, textTransform: 'uppercase', letterSpacing: 1.3 },
  link: { color: color.ink, textDecorationLine: 'underline', textDecorationColor: color.lineStrong, cursor: 'pointer' },
  sectionTitle: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: color.ink },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  card: { backgroundColor: color.raised, borderRadius: radius.lg, padding: 20, gap: 12 },
  rule: { height: 1, backgroundColor: color.line },
  notice: { backgroundColor: color.surface, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.sm },
  warn: { backgroundColor: color.accentSoft, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  empty: { alignItems: 'center', gap: 16, paddingVertical: 40, paddingHorizontal: 20, borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.line },
  emptyText: { fontStyle: 'italic', fontSize: 19, lineHeight: 27, color: color.muted, textAlign: 'center' },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TOUCH, cursor: 'pointer' },
  disclosureMark: { width: 14, color: color.muted, fontSize: 13, transitionProperty: 'transform', transitionDuration: '150ms' },
  btn: { minHeight: TOUCH, paddingHorizontal: 20, borderRadius: radius.pill, backgroundColor: color.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', transitionProperty: 'background-color, transform', transitionDuration: '150ms' },
  btnSmall: { minHeight: 38, paddingHorizontal: 15 },
  btnPrimary: { backgroundColor: color.ink, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.25)' },
  btnRing: { backgroundColor: 'transparent', boxShadow: `inset 0 0 0 1px ${color.lineStrong}` },
  btnText: { fontFamily: font.sans, fontSize: 15, fontWeight: '600', color: color.ink },
  btnTextSmall: { fontSize: 14 },
  segmented: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: color.surface, padding: 4, borderRadius: radius.pill, gap: 2 },
  segment: { minHeight: 38, paddingHorizontal: 18, borderRadius: radius.pill, justifyContent: 'center', cursor: 'pointer' },
  segmentOn: { backgroundColor: color.raised, boxShadow: '0 1px 2px rgba(40,30,20,0.14), 0 0 0 1px rgba(40,30,20,0.04)' },
  segmentText: { fontFamily: font.sans, fontSize: 14, fontWeight: '600', color: color.muted },
  fieldLabel: { fontFamily: font.sans, fontSize: 14, fontWeight: '600', color: color.ink2 },
  // 16px text, or iPhones zoom in on the field when it's tapped.
  input: { fontFamily: font.sans, fontSize: 16, lineHeight: 22, color: color.ink, backgroundColor: color.raised, borderWidth: 1, borderColor: color.line, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: 14, minHeight: 48, outlineStyle: 'none' },
  inputFocused: { borderColor: color.accent, boxShadow: `0 0 0 3px ${color.accentRing}` },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TOUCH, cursor: 'pointer' },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.lineStrong, backgroundColor: color.raised, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: color.accent, borderColor: color.accent },
  tick: { color: color.accentInk, fontSize: 14, lineHeight: 16, fontWeight: '700' },
  chip: { backgroundColor: color.surface, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 11, alignSelf: 'flex-start' },
  chipText: { fontFamily: font.sans, fontSize: 12, lineHeight: 18, fontWeight: '500', color: color.ink2 },
  chipAccent: { color: color.accent, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.6, fontSize: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.ink2 },
  dotOpen: { backgroundColor: color.accent, boxShadow: `0 0 0 3px ${color.accentSoft}` },
  dotClosed: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: color.muted },
  badgeText: { fontFamily: font.sans, fontSize: 13, lineHeight: 18, fontWeight: '500', color: color.ink2, flexShrink: 1 },
  tag: { fontFamily: font.sans, fontSize: 13, lineHeight: 20, color: color.muted },
  tagYou: { backgroundColor: color.surface, color: color.ink2, paddingHorizontal: 8, borderRadius: radius.pill, fontSize: 12, overflow: 'hidden' },
  tagExpert: { color: color.accent, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.3 },
  avatar: { borderRadius: 999, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' },
  cdUnit: { fontFamily: font.sans, fontSize: '0.68em', color: color.muted, marginLeft: 1 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(28,26,23,0.45)' },
  sheet: { backgroundColor: color.raised, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 'max(20px, env(safe-area-inset-bottom))', maxHeight: '85%', width: '100%', maxWidth: 640, alignSelf: 'center', boxShadow: '0 -12px 40px rgba(20,14,8,0.25)' },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: color.surface2, marginBottom: 12 },
});
