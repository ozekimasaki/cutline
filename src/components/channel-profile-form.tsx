import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CHANNEL_POLICIES,
  CHANNEL_RULE_KEYS,
  parseChannelPolicy,
  type ChannelProfile,
  type ChannelRuleKey,
} from "@/lib/types";

export function ChannelProfileForm({
  profile,
  onChange,
}: {
  profile: ChannelProfile;
  onChange: (next: ChannelProfile) => void;
}) {
  const setRule = (key: ChannelRuleKey, raw: string) => {
    onChange({
      ...profile,
      rules: {
        ...profile.rules,
        [key]: parseChannelPolicy(raw, profile.rules[key]),
      },
    });
  };

  return (
    <div className="grid gap-2">
      <Label>この番組での扱い</Label>
      <p className="text-xs text-muted-foreground">
        笑い、沈黙、相槌をどう残すか。
      </p>
      <div className="grid gap-2">
        {CHANNEL_RULE_KEYS.map((key) => (
          <label
            key={key}
            className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 text-sm"
          >
            <span className="text-muted-foreground">{key}</span>
            <select
              value={profile.rules[key]}
              onChange={(event) => setRule(key, event.target.value)}
              className={cn(
                "h-8 rounded-md border border-input bg-background px-2 text-xs",
              )}
            >
              {CHANNEL_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
