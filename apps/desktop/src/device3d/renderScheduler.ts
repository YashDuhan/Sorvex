// Ported from t3code (https://github.com/pingdotgg/t3code), packages/client-runtime/src/device/renderScheduler.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see LICENSE-t3code in this folder.
export function createRenderScheduler(
  render: () => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (disposed || pending !== null) return;
      pending = request(() => {
        pending = null;
        if (!disposed) render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
