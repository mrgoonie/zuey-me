import React from 'react';
import { PresenceDiagnosticsPanel } from './PresenceDiagnosticsPanel';
import { PresenceOwnerPanel } from './PresenceOwnerPanel';

interface PresenceStudioTabProps {
  /** The signed-in admin is the presence owner (decided server-side): only then the owner controls render. */
  owner: boolean;
}

/** Studio Presence tab: owner status controls for the owner only, Worker diagnostics for every admin. */
export const PresenceStudioTab: React.FC<PresenceStudioTabProps> = ({ owner }) => (
  <div className="space-y-6">
    {owner && <PresenceOwnerPanel />}
    <PresenceDiagnosticsPanel />
  </div>
);
