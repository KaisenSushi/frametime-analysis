/**
 * V2 shell - mode/step navigation, auto-advance, chart resize.
 * Single UI (classic shell removed).
 */
(function () {
  const MODES = ['visualization', 'statistics', 'reliability'];
  const STEPS = ['setup', 'results'];

  let shellWired = false;
  let vizStepAdvanceWired = false;
  let statsStepAdvanceWired = false;

  function getActiveV2Mode() {
    return document.querySelector('.v2-mode:not(.hidden)')?.getAttribute('data-mode') || null;
  }

  function resizeMainChart() {
    const chart = window.mainChart;
    if (!chart) return;
    try {
      chart.resize?.();
      chart.update?.('none');
    } catch (err) {
      console.warn('Chart resize failed:', err);
    }
  }

  function resizeReliabilityChart() {
    const canvas = document.getElementById('reliabilityChart');
    if (!canvas) return;
    try {
      const chart = window.Chart?.getChart?.(canvas);
      if (chart) {
        chart.resize?.();
        chart.update?.('none');
      }
    } catch (err) {
      console.warn('Reliability chart resize failed:', err);
    }
  }

  function scheduleChartResize(kind) {
    requestAnimationFrame(() => {
      if (kind === 'visualization' || kind === 'all') {
        resizeMainChart();
        window.resizeAnalysisBoardCharts?.();
      }
      if (kind === 'reliability' || kind === 'all') resizeReliabilityChart();
      requestAnimationFrame(() => {
        if (kind === 'visualization' || kind === 'all') {
          resizeMainChart();
          window.resizeAnalysisBoardCharts?.();
        }
        if (kind === 'reliability' || kind === 'all') resizeReliabilityChart();
      });
    });
  }

  function syncModeTablist(mode) {
    document.querySelectorAll('.v2-mode-btn').forEach(btn => {
      const active = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
  }

  function syncStepTablist(step) {
    document.querySelectorAll('.v2-step').forEach(btn => {
      const active = btn.getAttribute('data-step') === step;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
  }

  function syncWorkflowAria(mode = getActiveV2Mode(), step = null) {
    if (!mode) return;
    const activeMode = document.querySelector(`.v2-mode[data-mode="${mode}"]`);
    const activeStep = step || activeMode?.querySelector('.v2-step-panel:not(.hidden)')?.getAttribute('data-step') || 'setup';

    document.querySelectorAll('.v2-step').forEach(button => {
      const buttonStep = button.getAttribute('data-step');
      const panel = activeMode?.querySelector(`.v2-step-panel[data-step="${buttonStep}"]`);
      if (panel?.id) button.setAttribute('aria-controls', panel.id);
    });

    document.querySelectorAll('.v2-mode').forEach(modeSection => {
      const modeActive = modeSection.getAttribute('data-mode') === mode;
      modeSection.querySelectorAll('.v2-step-panel').forEach(panel => {
        const panelStep = panel.getAttribute('data-step');
        const visible = modeActive && panelStep === activeStep && !panel.classList.contains('hidden');
        panel.setAttribute('aria-hidden', String(!visible));
        panel.setAttribute('aria-labelledby', panelStep === 'results' ? 'v2StepResults' : 'v2StepSetup');
      });
    });
  }

  function focusStepLanding(mode, step) {
    const modeSection = document.querySelector(`.v2-mode[data-mode="${mode}"]`);
    const panel = modeSection?.querySelector(`.v2-step-panel[data-step="${step}"]`);
    const landing = panel?.querySelector('[data-v2-focus-landing]') || panel;
    if (!landing) return;
    requestAnimationFrame(() => {
      landing.focus({ preventScroll: true });
    });
  }

  function setMode(mode, { focusPanel = false } = {}) {
    if (!MODES.includes(mode)) return;
    document.querySelectorAll('.v2-mode').forEach(section => {
      const active = section.getAttribute('data-mode') === mode;
      section.classList.toggle('hidden', !active);
      section.setAttribute('aria-hidden', String(!active));
    });
    syncModeTablist(mode);
    syncWorkflowAria(mode);
    const title = document.getElementById('v2WorkspaceTitle');
    if (title) {
      title.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    }
    if (focusPanel) {
      const step = document.querySelector(`.v2-mode[data-mode="${mode}"] .v2-step-panel:not(.hidden)`)
        ?.getAttribute('data-step') || 'setup';
      focusStepLanding(mode, step);
    }
  }

  function setStep(step, { focusPanel = false } = {}) {
    if (!STEPS.includes(step)) return;
    const activeMode = document.querySelector('.v2-mode:not(.hidden)');
    if (!activeMode) return;
    const mode = activeMode.getAttribute('data-mode');

    activeMode.querySelectorAll('.v2-step-panel').forEach(panel => {
      const active = panel.getAttribute('data-step') === step;
      panel.classList.toggle('hidden', !active);
    });

    syncStepTablist(step);
    syncWorkflowAria(mode, step);

    if (step === 'results') {
      if (mode === 'visualization') scheduleChartResize('visualization');
      if (mode === 'reliability') scheduleChartResize('reliability');
    }

    if (focusPanel) {
      focusStepLanding(mode, step);
    }
  }

  function wireShell() {
    if (shellWired) return;
    shellWired = true;

    const modeButtons = () => Array.from(document.querySelectorAll('.v2-mode-btn'));
    const stepButtons = () => Array.from(document.querySelectorAll('.v2-step'));

    modeButtons().forEach(btn => {
      btn.addEventListener('click', () => {
        setMode(btn.getAttribute('data-mode'));
        setStep('setup', { focusPanel: true });
      });
    });

    stepButtons().forEach(btn => {
      btn.addEventListener('click', () => {
        setStep(btn.getAttribute('data-step'), { focusPanel: true });
      });
    });

    document.querySelector('.v2-mode-switch')?.addEventListener('keydown', event => {
      const items = modeButtons();
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      let nextIndex = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % items.length;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index - 1 + items.length) % items.length;
      }
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = items.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      setMode(items[nextIndex].getAttribute('data-mode'));
      setStep('setup');
      items[nextIndex].focus();
    });

    document.querySelector('.v2-step-nav')?.addEventListener('keydown', event => {
      const items = stepButtons();
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      let nextIndex = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % items.length;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index - 1 + items.length) % items.length;
      }
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = items.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      setStep(items[nextIndex].getAttribute('data-step'));
      items[nextIndex].focus();
    });
  }

  function wireAddToChartStepAdvance() {
    if (vizStepAdvanceWired) return;
    const btn = document.getElementById('addToChartBtn');
    if (!btn) return;
    vizStepAdvanceWired = true;

    btn.addEventListener('click', () => {
      if (getActiveV2Mode() !== 'visualization') return;

      const container = document.getElementById('chartContainer');
      let seenBusy = false;
      const started = performance.now();

      const tick = () => {
        if (getActiveV2Mode() !== 'visualization') return;
        const busy = container?.classList.contains('chart-busy');
        if (busy) seenBusy = true;

        if (seenBusy && !busy) {
          const hasChart = Boolean(window.mainChart) ||
            Boolean(window.analysisBoardReady) ||
            (Array.isArray(window.chartDatasets) && window.chartDatasets.length > 0);
          if (hasChart) {
            setStep('results', { focusPanel: true });
            scheduleChartResize('visualization');
          }
          return;
        }

        if (performance.now() - started > 60000) return;
        requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    });
  }

  function wireCalculateStatsStepAdvance() {
    if (statsStepAdvanceWired) return;
    const btn = document.getElementById('calculateStatsBtn');
    if (!btn) return;
    statsStepAdvanceWired = true;

    btn.addEventListener('click', () => {
      if (getActiveV2Mode() !== 'statistics') return;

      const finish = () => {
        if (getActiveV2Mode() !== 'statistics') return;
        const statsContent = document.getElementById('statistics');
        if (statsContent && !statsContent.classList.contains('empty-stats')) {
          setStep('results', { focusPanel: true });
        }
      };

      let seenBusy = btn.getAttribute('aria-busy') === 'true';
      const started = performance.now();
      const tick = () => {
        const busy = btn.getAttribute('aria-busy') === 'true' ||
          document.getElementById('statistics')?.getAttribute('aria-busy') === 'true';
        if (busy) seenBusy = true;
        if (seenBusy && !busy) {
          finish();
          return;
        }
        if (!seenBusy && performance.now() - started > 32) {
          finish();
          return;
        }
        if (performance.now() - started > 60000) return;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }


  function init() {
    wireShell();
    wireAddToChartStepAdvance();
    wireCalculateStatsStepAdvance();
    setMode('visualization');
    setStep('setup');
  }

  window.setV2Mode = setMode;
  window.setV2Step = setStep;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
