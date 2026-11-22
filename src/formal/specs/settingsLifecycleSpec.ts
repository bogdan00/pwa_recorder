/**
 * Formal Specification: Studio Settings Modal, Tabs, Disclosure & Mic Test Lifecycle
 * (Single-IR Dual-Backend LTS)
 *
 * Related CUJs: cuj/CUJ-06-library-browsing-themes.md, cuj/CUJ-07-quality-and-devices.md,
 *               cuj/CUJ-08-draft-recovery-drive-pwa.md, cuj/CUJ-09-multi-user-sharing.md
 * Related ADR:  adr/ADR-11-two-tier-formal-verification.md
 * Production implementations: src/views/SettingsSheet.tsx, src/hooks/useMicTest.ts,
 *                             src/views/settings/QualitySettingsSection.tsx, src/App.tsx
 *
 * SINGLE SOURCE OF TRUTH (Zero Tier-1 ↔ Tier-2 Drift):
 * All 9 safety invariants AND all 12 transition rules are defined ONCE using `exprIr.ts`:
 *   - Tier 1 (BFS Model Checker + Automated Positive/Negative Conformance):
 *       Evaluates `SETTINGS_INVARIANT_IR` and `SETTINGS_TRANSITIONS_IR` concretely via
 *       `evalInt`/`evalBool`, then replays BFS-harvested traces against the real mounted
 *       `<SettingsSheet>` + `<ThemeSwitcherSheet>` + `useMicTest` React tree.
 *   - Tier 2 (Z3 SMT Unbounded Mathematical Induction):
 *       Compiles the EXACT SAME `SETTINGS_INVARIANT_IR` and `SETTINGS_TRANSITIONS_IR` ASTs
 *       directly into Z3 SMT expressions via `z3ExprCompiler.ts`.
 */

import type { SettingsTab } from '../../views/SettingsSheet';
import {
  E,
  evalBool,
  evalInt,
  type BoolExpr,
  type EvalEnv,
  type IntExpr,
} from '../core/exprIr';
import type {
  LabeledTransitionSystem,
  ReachabilityGoal,
  SafetyInvariant,
} from '../core/modelChecker';

export const SETTINGS_TAB_CODE: Readonly<Record<SettingsTab, number>> = {
  recording: 0,
  drive: 1,
  app: 2,
};

const CODE_TO_TAB: readonly SettingsTab[] = ['recording', 'drive', 'app'];

export interface SettingsFormalState {
  /** Whether Studio Settings sheet is open. */
  readonly open: boolean;
  /** Currently active segmented tab (recording | drive | app). */
  readonly tab: SettingsTab;
  /** Whether the collapsible "Advanced Audio & Input Gain" panel is expanded. */
  readonly advancedOpen: boolean;
  /** Whether a live microphone test stream/session is currently active. */
  readonly micTestActive: boolean;
  /** Whether ThemeSwitcherSheet is open (either standalone from Library or stacked above Settings App tab). */
  readonly themeSwitcherOpen: boolean;
  /** Unbounded monotonic counter of Settings open events (proves unbounded session safety in Z3). */
  readonly openCount: number;
}

export type SettingsAction =
  | 'open_default'
  | 'open_drive'
  | 'switch_recording'
  | 'switch_drive'
  | 'switch_app'
  | 'toggle_advanced'
  | 'start_mic_test'
  | 'stop_mic_test'
  | 'open_theme_from_settings'
  | 'open_theme_from_library'
  | 'close_theme_switcher'
  | 'close_settings';

export const SETTINGS_ACTIONS: readonly SettingsAction[] = [
  'open_default',
  'open_drive',
  'switch_recording',
  'switch_drive',
  'switch_app',
  'toggle_advanced',
  'start_mic_test',
  'stop_mic_test',
  'open_theme_from_settings',
  'open_theme_from_library',
  'close_theme_switcher',
  'close_settings',
];

export const SETTINGS_INITIAL_STATE: SettingsFormalState = {
  open: false,
  tab: 'recording',
  advancedOpen: false,
  micTestActive: false,
  themeSwitcherOpen: false,
  openCount: 0,
};

// ============================================================================
// Shared Declarative IR for State Variables, Invariants & Transitions
// ============================================================================

export interface SettingsIrStateVars {
  readonly open: BoolExpr;
  readonly tab: IntExpr;
  readonly advancedOpen: BoolExpr;
  readonly micTestActive: BoolExpr;
  readonly themeSwitcherOpen: BoolExpr;
  readonly openCount: IntExpr;
}

export function settingsIrVars(prefix = ''): SettingsIrStateVars {
  const p = (name: string) => (prefix ? `${prefix}_${name}` : name);
  return {
    open: E.boolVar(p('open')),
    tab: E.intVar(p('tab')),
    advancedOpen: E.boolVar(p('advancedOpen')),
    micTestActive: E.boolVar(p('micTestActive')),
    themeSwitcherOpen: E.boolVar(p('themeSwitcherOpen')),
    openCount: E.intVar(p('openCount')),
  };
}

export function settingsStateToEnv(s: SettingsFormalState): EvalEnv {
  return {
    ints: {
      tab: SETTINGS_TAB_CODE[s.tab],
      openCount: s.openCount,
    },
    bools: {
      open: s.open,
      advancedOpen: s.advancedOpen,
      micTestActive: s.micTestActive,
      themeSwitcherOpen: s.themeSwitcherOpen,
    },
  };
}

export interface SettingsInvariantIr {
  readonly name: string;
  readonly expr: BoolExpr;
}

const S = settingsIrVars();
const REC = E.int(SETTINGS_TAB_CODE.recording);
const DRIVE = E.int(SETTINGS_TAB_CODE.drive);
const APP = E.int(SETTINGS_TAB_CODE.app);

/**
 * The 8 Safety Invariants (□ Inv) defined ONCE as Expression IR ASTs.
 * Evaluated by Tier 1 BFS & Conformance, AND compiled verbatim into Z3 by Tier 2!
 */
export const SETTINGS_INVARIANT_IR: readonly SettingsInvariantIr[] = [
  {
    name: 'valid_tab_enum',
    expr: E.and(E.ge(S.tab, REC), E.le(S.tab, APP)),
  },
  {
    name: 'open_count_non_negative',
    expr: E.ge(S.openCount, E.int(0)),
  },
  {
    name: 'no_mic_leak_when_closed',
    expr: E.implies(E.not(S.open), E.not(S.micTestActive)),
  },
  {
    name: 'mic_test_only_on_recording_tab',
    expr: E.implies(S.micTestActive, E.and(S.open, E.eq(S.tab, REC))),
  },
  {
    name: 'no_mic_test_under_theme_switcher',
    expr: E.implies(S.themeSwitcherOpen, E.not(S.micTestActive)),
  },
  {
    name: 'advanced_disclosure_only_on_recording_tab',
    expr: E.implies(S.advancedOpen, E.and(S.open, E.eq(S.tab, REC))),
  },
  {
    name: 'stacked_theme_switcher_requires_app_tab',
    expr: E.implies(E.and(S.open, S.themeSwitcherOpen), E.eq(S.tab, APP)),
  },
  {
    name: 'open_implies_positive_open_count',
    expr: E.implies(S.open, E.ge(S.openCount, E.int(1))),
  },
  {
    name: 'closed_state_canonical_tab',
    expr: E.implies(E.not(S.open), E.eq(S.tab, REC)),
  },
];

export interface SettingsTransitionIr {
  readonly name: SettingsAction;
  readonly guard: BoolExpr;
  readonly next: {
    readonly open?: BoolExpr;
    readonly tab?: IntExpr;
    readonly advancedOpen?: BoolExpr;
    readonly micTestActive?: BoolExpr;
    readonly themeSwitcherOpen?: BoolExpr;
    readonly openCount?: IntExpr;
  };
}

/**
 * All 12 Transitions defined ONCE as declarative Expression IR ASTs.
 * Both Tier 1 and Tier 2 execute/compile these exact records.
 */
export const SETTINGS_TRANSITIONS_IR: Readonly<
  Record<SettingsAction, SettingsTransitionIr>
> = {
  open_default: {
    name: 'open_default',
    guard: E.and(E.not(S.open), E.not(S.themeSwitcherOpen)),
    next: {
      open: E.bool(true),
      tab: REC,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
      openCount: E.add(S.openCount, E.int(1)),
    },
  },
  open_drive: {
    name: 'open_drive',
    guard: E.and(E.not(S.open), E.not(S.themeSwitcherOpen)),
    next: {
      open: E.bool(true),
      tab: DRIVE,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
      openCount: E.add(S.openCount, E.int(1)),
    },
  },
  switch_recording: {
    name: 'switch_recording',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen), E.neq(S.tab, REC)),
    next: {
      tab: REC,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
    },
  },
  switch_drive: {
    name: 'switch_drive',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen), E.neq(S.tab, DRIVE)),
    next: {
      tab: DRIVE,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
    },
  },
  switch_app: {
    name: 'switch_app',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen), E.neq(S.tab, APP)),
    next: {
      tab: APP,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
    },
  },
  toggle_advanced: {
    name: 'toggle_advanced',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen), E.eq(S.tab, REC)),
    next: {
      advancedOpen: E.not(S.advancedOpen),
    },
  },
  start_mic_test: {
    name: 'start_mic_test',
    guard: E.and(
      S.open,
      E.not(S.themeSwitcherOpen),
      E.eq(S.tab, REC),
      E.not(S.micTestActive),
    ),
    next: {
      micTestActive: E.bool(true),
    },
  },
  stop_mic_test: {
    name: 'stop_mic_test',
    guard: E.and(
      S.open,
      E.not(S.themeSwitcherOpen),
      E.eq(S.tab, REC),
      S.micTestActive,
    ),
    next: {
      micTestActive: E.bool(false),
    },
  },
  open_theme_from_settings: {
    name: 'open_theme_from_settings',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen), E.eq(S.tab, APP)),
    next: {
      themeSwitcherOpen: E.bool(true),
    },
  },
  open_theme_from_library: {
    name: 'open_theme_from_library',
    guard: E.and(E.not(S.open), E.not(S.themeSwitcherOpen)),
    next: {
      themeSwitcherOpen: E.bool(true),
    },
  },
  close_theme_switcher: {
    name: 'close_theme_switcher',
    guard: S.themeSwitcherOpen,
    next: {
      themeSwitcherOpen: E.bool(false),
    },
  },
  close_settings: {
    name: 'close_settings',
    guard: E.and(S.open, E.not(S.themeSwitcherOpen)),
    next: {
      open: E.bool(false),
      tab: REC,
      advancedOpen: E.bool(false),
      micTestActive: E.bool(false),
    },
  },
};

function evalTransitionIr(
  s: SettingsFormalState,
  ir: SettingsTransitionIr,
): SettingsFormalState | null {
  const env = settingsStateToEnv(s);
  if (!evalBool(ir.guard, env)) return null;
  const nextTabCode = ir.next.tab
    ? evalInt(ir.next.tab, env)
    : SETTINGS_TAB_CODE[s.tab];
  return {
    open: ir.next.open ? evalBool(ir.next.open, env) : s.open,
    tab: CODE_TO_TAB[nextTabCode] ?? s.tab,
    advancedOpen: ir.next.advancedOpen
      ? evalBool(ir.next.advancedOpen, env)
      : s.advancedOpen,
    micTestActive: ir.next.micTestActive
      ? evalBool(ir.next.micTestActive, env)
      : s.micTestActive,
    themeSwitcherOpen: ir.next.themeSwitcherOpen
      ? evalBool(ir.next.themeSwitcherOpen, env)
      : s.themeSwitcherOpen,
    openCount: ir.next.openCount ? evalInt(ir.next.openCount, env) : s.openCount,
  };
}

export const SETTINGS_INVARIANTS: readonly SafetyInvariant<SettingsFormalState>[] =
  SETTINGS_INVARIANT_IR.map((inv) => ({
    name: inv.name,
    check: (s) => evalBool(inv.expr, settingsStateToEnv(s)),
  }));

export const SETTINGS_REACHABILITY_GOALS: readonly ReachabilityGoal<SettingsFormalState>[] =
  [
    {
      name: 'can_run_mic_test_with_advanced_audio_expanded',
      check: (s) =>
        s.open && s.tab === 'recording' && s.micTestActive && s.advancedOpen,
    },
    {
      name: 'can_open_context_aware_drive_tab_directly',
      check: (s) => s.open && s.tab === 'drive' && !s.micTestActive,
    },
    {
      name: 'can_stack_theme_switcher_above_settings_app_tab',
      check: (s) =>
        s.open && s.tab === 'app' && s.themeSwitcherOpen && !s.micTestActive,
    },
    {
      name: 'can_open_standalone_theme_switcher_from_library',
      check: (s) => !s.open && s.themeSwitcherOpen && !s.micTestActive,
    },
    {
      name: 'can_close_cleanly_after_multiple_sessions',
      check: (s) =>
        !s.open && !s.themeSwitcherOpen && !s.micTestActive && s.openCount >= 2,
    },
  ];

/**
 * Tier 1 finite-state step relation executed directly from `SETTINGS_TRANSITIONS_IR`.
 * `maxOpenCount` bounds the BFS open counter (default 2) while Tier 2 Z3 proves
 * unbounded `openCount ∈ ℤ≥0`.
 */
export function stepSettingsLifecycleState(
  s: SettingsFormalState,
  action: SettingsAction,
  maxOpenCount = 2,
): SettingsFormalState | null {
  if (
    (action === 'open_default' || action === 'open_drive') &&
    s.openCount >= maxOpenCount
  ) {
    return null;
  }
  return evalTransitionIr(s, SETTINGS_TRANSITIONS_IR[action]);
}

export function serializeSettingsState(s: SettingsFormalState): string {
  return [
    s.open ? 1 : 0,
    s.tab,
    s.advancedOpen ? 1 : 0,
    s.micTestActive ? 1 : 0,
    s.themeSwitcherOpen ? 1 : 0,
    s.openCount,
  ].join('|');
}

export function createSettingsLifecycleLts(
  maxOpenCount = 2,
): LabeledTransitionSystem<SettingsFormalState, SettingsAction> {
  return {
    name: 'SettingsLifecycle',
    initialStates: [SETTINGS_INITIAL_STATE],
    actions: SETTINGS_ACTIONS,
    step: (state, action) =>
      stepSettingsLifecycleState(state, action, maxOpenCount),
    serialize: serializeSettingsState,
    invariants: SETTINGS_INVARIANTS,
    reachabilityGoals: SETTINGS_REACHABILITY_GOALS,
    maxStates: 2_000,
  };
}
