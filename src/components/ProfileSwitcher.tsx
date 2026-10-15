import { useEffect, useState } from 'react';
import { listProfiles, getStoredProfileId, setStoredProfileId, type DocWithId } from '../lib/firestore';
import type { ProfileDoc } from '../lib/db-models';
import { select } from '../theme';

type Props = {
  uid: string;
  profileId: string | null;
  onSelect: (id: string, name?: string) => void;
};

export function ProfileSwitcher({ uid, profileId, onSelect }: Props) {
  const [profiles, setProfiles] = useState<DocWithId<ProfileDoc>[]>([]);

  useEffect(() => {
    let cancelled = false;
    listProfiles(uid)
      .then((ps) => {
        if (cancelled) return;
        setProfiles(ps);
        if (!profileId && ps.length > 0) {
          // Prefer the stored selection, else the first profile (Jon).
          const stored = getStoredProfileId();
          const match = stored && ps.some((p) => p.id === stored) ? stored : ps[0]!.id;
          setStoredProfileId(match);
          onSelect(match, ps.find((p) => p.id === match)?.name);
        } else if (profileId) {
          onSelect(profileId, ps.find((p) => p.id === profileId)?.name);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  if (profiles.length === 0) return null;

  return (
    <select
      value={profileId ?? ''}
      onChange={(e) => {
        setStoredProfileId(e.target.value);
        onSelect(e.target.value, profiles.find((p) => p.id === e.target.value)?.name);
      }}
      aria-label="Profile"
      style={select}
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
