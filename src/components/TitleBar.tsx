import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Windows order + Apple circles: yellow min, green max, red close. Solid discs only — never glyphs. */
export function WindowControls() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win.onResized(() => {
      void win.isMaximized().then(setMaximized);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [win]);

  const toggleMaximize = () => {
    void win.toggleMaximize().then(() => win.isMaximized().then(setMaximized));
  };

  return (
    <div className="traffic-lights" aria-label="Contrôles fenêtre">
      <button type="button" className="tl tl-min" aria-label="Réduire" onClick={() => void win.minimize()} />
      <button type="button" className="tl tl-max" aria-label={maximized ? 'Restaurer' : 'Agrandir'} onClick={toggleMaximize} />
      <button type="button" className="tl tl-close" aria-label="Fermer" onClick={() => void win.close()} />
    </div>
  );
}
