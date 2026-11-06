import { useEffect, useState } from 'react';
import { bootstrap, useStore } from './lib/store';
import { Landing } from './components/Landing';
import { Shell } from './components/Shell';
import { ResetPassword } from './components/ResetPassword';
import { Toasts } from './components/Toasts';
import { Spinner } from './components/ui';

export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const bootstrapped = useStore((state) => state.bootstrapped);
  const me = useStore((state) => state.me);
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'google_failed') {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  let content;
  if (!bootstrapped) {
    content = (
      <div className="boot-screen">
        <div className="boot-mark">F</div>
        <Spinner size={22} />
      </div>
    );
  } else if (path === '/reset') {
    content = <ResetPassword />;
  } else if (!me) {
    content = <Landing invitePath={path.startsWith('/invite/') ? path.split('/')[2] : null} />;
  } else {
    content = <Shell inviteCode={path.startsWith('/invite/') ? path.split('/')[2] : null} />;
  }

  return (
    <>
      {content}
      <Toasts />
    </>
  );
}
