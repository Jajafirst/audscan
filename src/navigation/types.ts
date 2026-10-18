export type RootStackParamList = {
  Main: undefined;
  Scan: undefined;
  // Each pixelChecks flag is TRUE when the check FAILED, matching the
  // *Fail naming in CameraScreen. `null` means the check could not be run at
  // all — the reversing numeral reports this when OCR read nothing, and a
  // check that did not run must not be shown as either pass or fail.
  Verdict: { status: 'PASS' | 'REVIEW'; result?: any; serialNumber?: string; denomination?: number; confidence?: number; pixelChecks?: { rollingColour: boolean | null }; reason?: 'ok' | 'no_value' | 'no_tilt' | 'no_colour' };
  SecurityGuide: undefined;
  ScanHistory: { selectedId?: string } | undefined;
  Analytics: undefined;
  Privacy: undefined;
  AccessibilitySettings: undefined;
};

export type TabParamList = {
  Home: undefined;
  Alerts: undefined;
  Settings: undefined;
};