export type CueCode = "bent_arms" | "sagging_hips" | "square_reach" | "barn_door" | "foot_cut" | "sloppy_feet" | "idle_feet" | "hesitation";
export type CoreCueCode = "foot_cut" | "bent_arms" | "sagging_hips" | "hesitation";
export const CORE_CUE_CODES: CoreCueCode[] = ["foot_cut", "bent_arms", "sagging_hips", "hesitation"];
export type Side = "left" | "right" | "center" | "both";

export const RULES: Record<CueCode, { title: string; cue: string; detail: string; priority: number; min: number; observation?: number; grace?: number; cooldown: number }> = {
  bent_arms: { title: "Locked-arm pulling", cue: "Hang longer, then drive with your feet.", detail: "Your elbow stayed loaded while your feet were available.", priority: 5, min: 1, grace: 3, cooldown: 2.2 },
  sagging_hips: { title: "Hips off wall", cue: "Pull with the toes and bring the hips in.", detail: "Your hips separated from the shoulder-to-foot line.", priority: 5, min: .5, grace: 3, cooldown: 2.2 },
  square_reach: { title: "Square-on reach", cue: "Try a drop knee or flag before reaching.", detail: "Your shoulders and hips stayed square through a long reach.", priority: 4, min: .2, grace: 4, cooldown: 2 },
  barn_door: { title: "Barn-dooring", cue: "Set counter-pressure before the hand moves.", detail: "Your torso rotated as a foot lost stability.", priority: 5, min: .15, cooldown: 2 },
  foot_cut: { title: "Foot cut / tension loss", cue: "Keep tension through the cutting foot and drive through the toe.", detail: "A foot released after stable contact while a hand stayed anchored.", priority: 5, min: 0, grace: 2, cooldown: 1.6 },
  sloppy_feet: { title: "Foot placement", cue: "Watch the foothold until the foot is quiet.", detail: "A foot traced extra motion before settling.", priority: 4, min: .12, cooldown: 2.2 },
  idle_feet: { title: "Idle feet", cue: "Reset the feet between hand moves.", detail: "Your hands moved repeatedly while both feet stayed fixed.", priority: 4, min: .2, cooldown: 3 },
  hesitation: { title: "Hesitation", cue: "Stalled here — commit or climb on.", detail: "Your body went still mid-climb. This may be a useful pause, but avoid waiting under load without a plan.", priority: 1, min: 0, observation: 1, cooldown: 4 },
};
