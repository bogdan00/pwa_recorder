import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App';
import { pwaInstallController } from './pwa/installPrompt';
import { applyThemeToDocument, loadSettings } from './storage/settings';

// Capture beforeinstallprompt & standalone status immediately before first render
pwaInstallController.init();

// Apply saved theme immediately before first paint to prevent flash
applyThemeToDocument(loadSettings().theme);

const Root: React.FC = () => {
  const [updateReady, setUpdateReady] = useState(false);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | undefined>(
    undefined,
  );

  useEffect(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setUpdateReady(true);
        setApplyUpdate(() => () => {
          void updateSW(true);
        });
      },
    });
  }, []);

  return <App pwaUpdateReady={updateReady} onApplyPwaUpdate={applyUpdate} />;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
