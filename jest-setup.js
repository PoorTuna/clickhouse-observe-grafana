// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// jsdom has no ResizeObserver — needed by @grafana/ui's Drawer/Tooltip internals (Diagnostics
// components are the first tests in this repo to actually mount a real Drawer rather than the
// inline panel chrome LogDetailDrawer.tsx uses). A no-op stub is enough: nothing under test
// depends on resize callbacks actually firing.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Same story for IntersectionObserver — used by Drawer's ScrollContainer for its scroll-shadow
// indicators.
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
