import { useAuth } from '../lib/auth';
import { btnPrimary, muted, faultText, hero, c } from '../theme';

export function SignIn() {
  const { signIn, authError } = useAuth();
  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '80px auto',
        padding: '20px',
        textAlign: 'center',
        fontFamily: 'system-ui',
        color: c.text,
        backgroundColor: c.bg,
        minHeight: '100svh',
      }}
    >
      <h1 style={{ ...hero, fontSize: '44px', textAlign: 'center' }}>Climbing Coach</h1>
      <p style={{ ...muted, margin: '16px 0 32px 0', fontSize: '16px' }}>
        Sign in to sync your analyses, history, and label library across devices.
      </p>
      <button onClick={signIn} style={{ ...btnPrimary, padding: '14px 32px', fontSize: '17px' }}>
        Sign in with Google
      </button>
      {authError && <p style={{ ...faultText, marginTop: '16px', fontSize: '14px' }}>{authError}</p>}
    </div>
  );
}
