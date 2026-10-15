import { CORE_CUE_CODES, RULES, type CoreCueCode, type CueCode, type Side } from "./references";
import { advanceEventStates, createEventStates, type DetectorFiring, type EventState } from "./eventMachine";

declare const Pose: any;

export type Landmark = { x: number; y: number; z?: number; visibility?: number };
export type CueEvent = {
  code: string;
  title: string;
  suggestion: string;
  severity: number;
  duration_ms: number;
  start_ms: number;
  end_ms: number;
  peak_ms: number;
  joint_name: string | null;
  side: Side | null;
  is_fused: boolean;
  coaching_note?: string;
  ghost_foot?: {
    x: number;
    y: number;
    side: "left" | "right";
    hip_dx: number;
    hip_dy: number;
  };
};
export type AnalysisFrame = { time: number; lms: Landmark[]; hipV: number; reliable: boolean };
export type StandoutNote = { title: string; comment: string; body_part: string; timestamp_ms: number };
export type TrackingQuality = {
  poseFrames: number;
  reliableFrames: number;
  armTrackedFrames: number;
  footTrackedFrames: number;
  totalFrames: number;
};
export type DetectorDiagnosticFrame = {
  time_s: number;
  reliable: boolean;
  landmarks: Array<{ index: number; x: number; y: number; z: number; visibility: number }>;
  features: {
    left_elbow_deg: number;
    right_elbow_deg: number;
    hip_depth_body: number;
    hip_lateral_offset_body: number;
    left_ankle_speed: number;
    right_ankle_speed: number;
    left_ankle_flex_deg?: number;
    right_ankle_flex_deg?: number;
    left_wrist_speed: number;
    right_wrist_speed: number;
    hip_speed: number;
    body_speed: number;
  };
  detector_scores: Record<CoreCueCode, number>;
  raw_signal_scores: Partial<Record<CueCode, number>>;
};
export type DismountClassification = "likely_fall" | "likely_controlled_dismount";
export type DismountEvent = {
  start_ms: number;
  end_ms: number;
  peak_ms: number;
  classification: DismountClassification;
  confidence: number;
  signals: string[];
};
export type PositiveTechniqueCode =
  | "hip_twist"
  | "straight_arms"
  | "quiet_feet"
  | "settled_grips"
  | "close_hips";
export type PositiveTechniqueScore = {
  code: PositiveTechniqueCode;
  title: string;
  score: number | null;
  successful_samples: number;
  relevant_samples: number;
  unit: "moments" | "grips";
};
export type AnalysisResult = { cues: CueEvent[]; detectorCues: CueEvent[]; dismounts: DismountEvent[]; frames: AnalysisFrame[]; diagnostics: DetectorDiagnosticFrame[]; positiveScores: PositiveTechniqueScore[]; totalFrames: number; reliableFrames: number; tracking: TrackingQuality; standout: StandoutNote | null };
export type LandmarkTraceSample = { time: number; landmarks: Landmark[] | null };

type Point = Landmark;
type RichFrame = AnalysisFrame & {
  ls: Point; rs: Point; le: Point; re: Point; lw: Point; rw: Point; lh: Point; rh: Point; lk: Point; rk: Point; la: Point; ra: Point; ltoe: Point; rtoe: Point;
  shoulder: Point; hip: Point; ankle: Point; shoulderWidth: number; bodyScale: number;
  leftElbow: number; rightElbow: number; leftKnee: number; rightKnee: number; leftAnkleFlex: number | null; rightAnkleFlex: number | null; footFlexRequired: boolean; shoulderLine: number; hipLine: number; shoulderSpan: number; hipSpan: number;
  leftWristV: number; rightWristV: number; leftAnkleV: number; rightAnkleV: number; leftKneeV: number; rightKneeV: number; leftElbowV: number; rightElbowV: number; shoulderV: number; hipUpV: number; shoulderUpV: number; bodyV: number; dt: number;
};
type Signal = { confidence: number; side: Side; joint: string };
type Firing = DetectorFiring<CueCode, Side>;
type RuleState = EventState<Side>;
type PogoInterval = { side: "left" | "right"; start: number; end: number };
export type IntentionalFlagSample = {
  time: number;
  side: "left" | "right";
  kneeAngle: number;
  legReach: number;
  lateralReach: number;
  depthReach: number;
  footSeparation: number;
  legVectorX: number;
  legVectorY: number;
  legVectorZ: number;
  flagAnkleSpeed: number;
  supportAnkleSpeed: number;
  bodySpeed: number;
  anchorHandSpeed: number;
  engaged: boolean;
};
export type IntentionalFlagInterval = { side: "left" | "right"; start: number; end: number };

const POSE_ANALYSIS_TIMEOUT_MS = 12_000;
const MAX_ANALYSIS_SAMPLES = 220;

const IDX = { ls:11, rs:12, le:13, re:14, lw:15, rw:16, lh:23, rh:24, la:27, ra:28, ltoe:31, rtoe:32 } as const;
const point = (lms: Landmark[], i: number): Point => lms[i] ?? { x: 0, y: 0, z: 0, visibility: 0 };
const center = (a: Point, b: Point): Point => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:((a.z ?? 0)+(b.z ?? 0))/2, visibility:Math.min(a.visibility ?? 0,b.visibility ?? 0) });
const dist = (a: Point,b: Point) => Math.hypot(a.x-b.x,a.y-b.y);
const normalizedPointLineDistance2D = (point: Point, lineStart: Point, lineEnd: Point) => {
  const dx = lineEnd.x - lineStart.x, dy = lineEnd.y - lineStart.y;
  const bodyLength2D = Math.hypot(dx, dy);
  if (bodyLength2D <= Number.EPSILON) return 0;
  const perpendicularDistance = Math.abs(dx * (lineStart.y - point.y) - (lineStart.x - point.x) * dy) / bodyLength2D;
  return perpendicularDistance / bodyLength2D;
};
const dist3 = (a: Point,b: Point) => Math.hypot(a.x-b.x,a.y-b.y,(a.z ?? 0)-(b.z ?? 0));
const angle = (a: Point,b: Point,c: Point) => { const abx=a.x-b.x, aby=a.y-b.y, cbx=c.x-b.x, cby=c.y-b.y; const den=Math.hypot(abx,aby)*Math.hypot(cbx,cby); return den ? Math.acos(Math.max(-1,Math.min(1,(abx*cbx+aby*cby)/den)))*180/Math.PI : 180; };
const lineAngle=(a:Point,b:Point)=>Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
const angleDelta=(a:number,b:number)=>{const d=Math.abs(a-b)%360; return d>180?360-d:d;};
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const visible=(lms:Landmark[],ids:number[],min:number)=>ids.every((i)=>(point(lms,i).visibility ?? 1)>=min);

function extractFrame(lms: Landmark[], time: number, prev: RichFrame | null): RichFrame {
  const ls=point(lms,IDX.ls),rs=point(lms,IDX.rs),le=point(lms,IDX.le),re=point(lms,IDX.re),lw=point(lms,IDX.lw),rw=point(lms,IDX.rw);
  const lh=point(lms,IDX.lh),rh=point(lms,IDX.rh),lk=point(lms,25),rk=point(lms,26),la=point(lms,IDX.la),ra=point(lms,IDX.ra),ltoe=point(lms,IDX.ltoe),rtoe=point(lms,IDX.rtoe);
  const shoulder=center(ls,rs),hip=center(lh,rh),ankle=center(la,ra),shoulderWidth=Math.max(dist(ls,rs),.06),bodyScale=Math.max(dist(shoulder,ankle),.28),dt=prev?Math.max(.04,time-prev.time):.25;
  const leftFootTracked=(ltoe.visibility??0)>=.25,rightFootTracked=(rtoe.visibility??0)>=.25;
  const vel=(p:Point,old:Point)=>prev?dist(p,old)/(bodyScale*dt):0;
  const tracked=[11,12,13,14,15,16,23,24,25,26,27,28];
  const count=tracked.filter((i)=>(point(lms,i).visibility ?? 1)>=.34).length;
  return {time,lms,ls,rs,le,re,lw,rw,lh,rh,lk,rk,la,ra,ltoe,rtoe,shoulder,hip,ankle,shoulderWidth,bodyScale,
    leftElbow:angle(ls,le,lw),rightElbow:angle(rs,re,rw),leftKnee:angle(lh,lk,la),rightKnee:angle(rh,rk,ra),
    leftAnkleFlex:leftFootTracked?angle(lk,la,ltoe):null,rightAnkleFlex:rightFootTracked?angle(rk,ra,rtoe):null,footFlexRequired:lms.length>32,
    shoulderLine:lineAngle(ls,rs),hipLine:lineAngle(lh,rh),shoulderSpan:dist3(ls,rs),hipSpan:dist3(lh,rh),
    leftWristV:prev?vel(lw,prev.lw):0,rightWristV:prev?vel(rw,prev.rw):0,leftAnkleV:prev?vel(la,prev.la):0,rightAnkleV:prev?vel(ra,prev.ra):0,
    leftKneeV:prev?vel(lk,prev.lk):0,rightKneeV:prev?vel(rk,prev.rk):0,leftElbowV:prev?vel(le,prev.le):0,rightElbowV:prev?vel(re,prev.re):0,
    hipV:prev?vel(hip,prev.hip):0,shoulderV:prev?vel(shoulder,prev.shoulder):0,
    hipUpV:prev?(prev.hip.y-hip.y)/(bodyScale*dt):0,shoulderUpV:prev?(prev.shoulder.y-shoulder.y)/(bodyScale*dt):0,
    bodyV:prev?(vel(hip,prev.hip)+vel(shoulder,prev.shoulder))/2:0,dt,
    reliable:visible(lms,[11,12,23,24],.34)&&count>=8};
}

const recent=(history:RichFrame[],seconds:number,time:number)=>history.filter((f)=>time-f.time<=seconds);
type LoadedFootSide = "left" | "right";

/**
 * A foot cut starts from pressure on a foothold. Position proves that a foot
 * could be loaded; motion proves that it actually settled before releasing.
 * Toe landmarks are deliberately excluded from this hard gate: MediaPipe's
 * frame-to-frame ankle-flex angle is too noisy, and an unflexed foot is often
 * exactly the foot that slips.
 */
function isPositionallyLoadedFootSample(frame: RichFrame, side: LoadedFootSide) {
  const hip = side === "left" ? frame.lh : frame.rh;
  const knee = side === "left" ? frame.leftKnee : frame.rightKnee;
  const ankle = side === "left" ? frame.la : frame.ra;
  const ankleDrop = (ankle.y - hip.y) / frame.bodyScale;
  const wallPlaneDistance = Math.min(
    Math.abs((ankle.z ?? 0) - (frame.lw.z ?? 0)),
    Math.abs((ankle.z ?? 0) - (frame.rw.z ?? 0)),
  ) / frame.bodyScale;
  const legVisible = side === "left"
    ? visible(frame.lms, [23, 25, 27], .34)
    : visible(frame.lms, [24, 26, 28], .34);
  const wallHandVisible = (point(frame.lms, 15).visibility ?? 1) >= .34
    || (point(frame.lms, 16).visibility ?? 1) >= .34;
  return frame.reliable
    && legVisible
    && wallHandVisible
    && ankleDrop >= .14
    && knee >= 35
    && knee <= 175
    && wallPlaneDistance <= 1.5;
}

const footSpeed = (frame: RichFrame, side: LoadedFootSide) => side === "left" ? frame.leftAnkleV : frame.rightAnkleV;
const footFlex = (frame: RichFrame, side: LoadedFootSide) => side === "left" ? frame.leftAnkleFlex : frame.rightAnkleFlex;

/**
 * Require an observable state change: consecutive samples of a positionally
 * loaded, controlled foot, followed by a sharp speed onset. When a short clip
 * starts immediately before the release, the one available controlled sample
 * is enough; otherwise require two so a continuously swinging flag cannot
 * qualify merely because it passes through a loaded-looking silhouette.
 */
function hasSettledLoadedSharpOnset(history: RichFrame[], frame: RichFrame, side: LoadedFootSide) {
  const onsetSpeed = footSpeed(frame, side);
  const prior = history
    .filter((sample) => sample.time < frame.time && frame.time - sample.time <= .8)
    .sort((a, b) => a.time - b.time);
  const immediatePrior = prior[prior.length - 1];
  if (!immediatePrior || onsetSpeed < 1 || onsetSpeed - footSpeed(immediatePrior, side) < .55) return false;

  const requiredControlledSamples = Math.min(2, prior.length);
  let controlledRun = 0;
  let previousControlled: RichFrame | null = null;
  let latestRunEnd = -Infinity;
  for (const sample of prior) {
    const consecutive = previousControlled !== null && sample.time - previousControlled.time <= .32;
    if (isPositionallyLoadedFootSample(sample, side) && footSpeed(sample, side) <= .8) {
      controlledRun = consecutive ? controlledRun + 1 : 1;
      previousControlled = sample;
      if (controlledRun >= requiredControlledSamples) latestRunEnd = sample.time;
    } else {
      controlledRun = 0;
      previousControlled = null;
    }
  }
  // The sharp onset must come directly out of that controlled support. Do not
  // let a later swing inherit an older loaded-looking pose.
  return frame.time - latestRunEnd <= .32;
}

type HipVelocitySample = { time: number; vx: number; vy: number; vz: number };

/**
 * A hold slip changes the climber's center of mass; moving a flag that was
 * pressed against the wall does not. Confirm that the hip either jerks (a
 * sharp velocity-vector change), drops, or spikes in speed within roughly
 * half a second of the foot's sharp onset. This deliberately uses the body
 * response rather than trying to infer whether the ankle was on a hold or on
 * the flat wall from an indistinguishable foot silhouette.
 */
function hasBodyResponseToFootUnload(frames: RichFrame[], onset: number) {
  const window = frames
    .filter((sample) => sample.time >= onset - .36 && sample.time <= onset + .52)
    .sort((a, b) => a.time - b.time);
  if (window.length < 3) return false;

  const velocities: HipVelocitySample[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1];
    const current = window[index];
    if (!previous || !current) continue;
    const dt = current.time - previous.time;
    if (dt < .08 || dt > .38) continue;
    const scale = Math.max(.28, (previous.bodyScale + current.bodyScale) / 2);
    velocities.push({
      time: current.time,
      vx: (current.hip.x - previous.hip.x) / (scale * dt),
      vy: (current.hip.y - previous.hip.y) / (scale * dt),
      vz: ((current.hip.z ?? 0) - (previous.hip.z ?? 0)) / (scale * dt),
    });
  }

  let peakHipAcceleration = 0;
  for (let index = 1; index < velocities.length; index += 1) {
    const previous = velocities[index - 1];
    const current = velocities[index];
    if (!previous || !current || current.time < onset - .08 || current.time > onset + .52) continue;
    const dt = current.time - previous.time;
    if (dt < .08 || dt > .38) continue;
    peakHipAcceleration = Math.max(
      peakHipAcceleration,
      Math.hypot(current.vx - previous.vx, current.vy - previous.vy, current.vz - previous.vz) / dt,
    );
  }

  const baseline = [...window].reverse().find((sample) => sample.time < onset);
  const response = window.filter((sample) => sample.time >= onset && sample.time <= onset + .52);
  if (!baseline || !response.length) return false;
  const baselineWindow = window.filter((sample) => sample.time < onset && sample.time >= onset - .3);
  const baselineHipSpeed = baselineWindow.length
    ? baselineWindow.reduce((sum, sample) => sum + sample.hipV, 0) / baselineWindow.length
    : baseline.hipV;
  const earlyResponse = response.filter((sample) => sample.time <= onset + .32);
  const earlyHipSpeed = Math.max(...earlyResponse.map((sample) => sample.hipV), 0);
  const hipDrop = Math.max(...response.map((sample) => (sample.hip.y - baseline.hip.y) / Math.max(.28, sample.bodyScale)), 0);

  const hipJerk = peakHipAcceleration >= 1.5;
  const suddenSpeedSpike = earlyHipSpeed >= .5 && earlyHipSpeed - baselineHipSpeed >= .24;
  const clearHipDrop = hipDrop >= .1;
  const bodyStalled = window
    .filter((sample) => sample.time >= onset - .2 && sample.time <= onset + .32)
    .every((sample) => sample.bodyV < .13 && sample.hipUpV < .08);
  return hipJerk || suddenSpeedSpike || clearHipDrop || bodyStalled;
}

function suppressFootCutsWithoutBodyResponse(firings: Firing[], frames: RichFrame[]) {
  // The body reacts to the first sharp foot-speed onset, before the event's
  // later confidence peak can absorb that response into its baseline.
  return firings.filter((firing) => firing.rule !== "foot_cut" || hasBodyResponseToFootUnload(frames, firing.start));
}

function averagePreReleaseAnkleFlex(
  history: RichFrame[],
  releaseTime: number,
  side: LoadedFootSide,
) {
  const values = history
    .filter(
      (sample) =>
        sample.time < releaseTime &&
        releaseTime - sample.time <= .55,
    )
    .map((sample) => footFlex(sample, side))
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length < 2) return null;
  const trimmed = values.length >= 5 ? values.slice(1, -1) : values;
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function gateFootCutSignal(signals: Partial<Record<CueCode, Signal>>, history: RichFrame[], frame: RichFrame) {
  const footCut = signals.foot_cut;
  if (!footCut) return signals;

  const faster: LoadedFootSide = frame.leftAnkleV >= frame.rightAnkleV ? "left" : "right";
  const slower: LoadedFootSide = faster === "left" ? "right" : "left";
  const fasterSpeed = Math.max(frame.leftAnkleV, frame.rightAnkleV);
  const slowerSpeed = Math.min(frame.leftAnkleV, frame.rightAnkleV);
  const candidateSides: LoadedFootSide[] = footCut.side === "left" || footCut.side === "right"
    ? [footCut.side]
    : fasterSpeed > 0 && slowerSpeed / fasterSpeed < .55
      ? [faster]
      : [faster, slower];
  const qualifiedSides = candidateSides.filter((side) => hasSettledLoadedSharpOnset(history, frame, side));
  const qualifies = candidateSides.length === 1 ? qualifiedSides.length === 1 : qualifiedSides.length === candidateSides.length;
  if (!qualifies) {
    const gated = { ...signals };
    delete gated.foot_cut;
    return gated;
  }

  return {
    ...signals,
    foot_cut: {
      ...footCut,
      confidence: clamp(footCut.confidence + .08),
    },
  };
}

type MotionKey = "lw" | "rw" | "la" | "ra";
const pathLength=(frames:RichFrame[],key:MotionKey)=>frames.slice(1).reduce((sum,f,i)=>sum+dist(frames[i]?.[key] ?? f[key],f[key])/f.bodyScale,0);
function reversals(frames:RichFrame[],key:"la"|"ra") { let count=0,last:{x:number;y:number}|null=null; for(let i=1;i<frames.length;i++){const f=frames[i],p=frames[i-1]; if(!f||!p)continue; const vx=(f[key].x-p[key].x)/f.bodyScale,vy=(f[key].y-p[key].y)/f.bodyScale,mag=Math.hypot(vx,vy); if(mag<.025)continue; if(last&&vx*last.x+vy*last.y<-.0002)count++; last={x:vx,y:vy};} return count; }
function bursts(frames:RichFrame[],key:"lw"|"rw"|"la"|"ra",threshold:number){let n=0,moving=false,quiet=0;for(let i=1;i<frames.length;i++){const f=frames[i],p=frames[i-1];if(!f||!p)continue;const speed=dist(p[key],f[key])/(f.bodyScale*Math.max(.04,f.dt));if(speed>threshold){if(!moving)n++;moving=true;quiet=0;}else if(moving&&++quiet>=2){moving=false;quiet=0;}}return n;}

function detectPogoIntervals(frames: RichFrame[]): PogoInterval[] {
  const intervals: PogoInterval[] = [];
  for (const side of ["left", "right"] as const) {
    const swingSpeedKey = side === "left" ? "leftAnkleV" : "rightAnkleV";
    const anchorSpeedKey = side === "left" ? "rightAnkleV" : "leftAnkleV";
    const swingPointKey: "la" | "ra" = side === "left" ? "la" : "ra";
    let startIndex: number | null = null;
    let landingCandidateIndex: number | null = null;
    const finish = (endIndex: number) => {
      if (startIndex === null) return;
      const segment = frames.slice(startIndex, endIndex + 1);
      const first = segment[0], last = segment[segment.length - 1];
      if (first && last) {
        const maxSwing = Math.max(...segment.map((frame) => frame[swingSpeedKey]));
        const anchoredRatio = segment.filter((frame) => frame[anchorSpeedKey] < .24).length / segment.length;
        const coordinatedDrive = segment.some((frame) => frame.bodyV > .11 && (frame.hipV > .1 || frame.shoulderV > .09 || Math.max(frame.leftWristV, frame.rightWristV) > .16));
        const swingTravel = pathLength(segment, swingPointKey);
        if (maxSwing > .28 && anchoredRatio >= .55 && coordinatedDrive && swingTravel > .13) intervals.push({ side, start: first.time, end: last.time });
      }
      startIndex = null;
      landingCandidateIndex = null;
    };
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue;
      const anchorHeld = frame[anchorSpeedKey] < .24;
      if (startIndex === null) {
        if (frame[swingSpeedKey] > .1 && anchorHeld) {
          // Begin at the last settled sample before the leg started to gather
          // speed, so the slow lead-in is part of the pogo, not a foot cut.
          let onset = i;
          for (let j = i - 1; j >= 0; j--) {
            const prior = frames[j];
            if (!prior) break;
            onset = j;
            if (prior[swingSpeedKey] < .035) break;
          }
          startIndex = onset;
        }
        continue;
      }

      // Re-engagement is a new stable support point, not a return to the takeoff
      // foothold. Start a candidate wherever the swinging foot first settles,
      // then confirm it only after the ankle remains planted there long enough
      // to rule out a brief apex pause. Confirmation is deliberately backdated
      // to this first settled frame so suppression ends at actual contact.
      if (frame[swingSpeedKey] < .08) {
        if (landingCandidateIndex === null) landingCandidateIndex = i;
        const landingStart = frames[landingCandidateIndex];
        if (landingStart) {
          const landingFrames = frames.slice(landingCandidateIndex, i + 1);
          const maxLandingDrift = landingFrames.reduce((max, sample) => Math.max(max, dist(sample[swingPointKey], landingStart[swingPointKey]) / sample.bodyScale), 0);
          const settledFor = frame.time - landingStart.time;
          const swingBeforeLanding = frames.slice(startIndex, landingCandidateIndex + 1);
          const hadCommittedSwing = swingBeforeLanding.length > 1
            && Math.max(...swingBeforeLanding.map((sample) => sample[swingSpeedKey])) > .28
            && pathLength(swingBeforeLanding, swingPointKey) > .13;
          const confirmedSupport = hadCommittedSwing && landingFrames.length >= 3 && settledFor >= .45 && maxLandingDrift < .07;
          if (confirmedSupport) finish(Math.max(startIndex, landingCandidateIndex));
        }
      } else {
        landingCandidateIndex = null;
      }
    }
    // A short review clip can end before the swinging foot visibly lands. A
    // committed out-and-back leg arc with the other foot anchored still gives
    // enough evidence to preserve the intentional pogo window.
    if (startIndex !== null) {
      const segment = frames.slice(startIndex);
      const first = segment[0], last = segment[segment.length - 1];
      if (first && last && last.time - first.time >= .7) {
        const maxSwing = Math.max(...segment.map((frame) => frame[swingSpeedKey]));
        const anchoredRatio = segment.filter((frame) => frame[anchorSpeedKey] < .24).length / segment.length;
        const coordinatedDrive = segment.some((frame) => frame.bodyV > .11 && (frame.hipV > .1 || frame.shoulderV > .09 || Math.max(frame.leftWristV, frame.rightWristV) > .16));
        const swingTravel = pathLength(segment, swingPointKey);
        if (maxSwing > .28 && anchoredRatio >= .65 && coordinatedDrive && swingTravel > .16 && reversals(segment, swingPointKey) >= 1) intervals.push({ side, start: first.time, end: last.time });
      }
    }
  }
  return intervals.sort((a, b) => a.start - b.start);
}

function flagSamples(frames: RichFrame[]): IntentionalFlagSample[] {
  return frames.flatMap((frame) => (["left", "right"] as const).map((side): IntentionalFlagSample => {
    const hip = side === "left" ? frame.lh : frame.rh;
    const ankle = side === "left" ? frame.la : frame.ra;
    const otherAnkle = side === "left" ? frame.ra : frame.la;
    const scale = frame.bodyScale;
    return {
      time: frame.time,
      side,
      kneeAngle: side === "left" ? frame.leftKnee : frame.rightKnee,
      legReach: dist3(hip, ankle) / scale,
      lateralReach: Math.abs(ankle.x - hip.x) / scale,
      depthReach: Math.abs((ankle.z ?? 0) - (hip.z ?? 0)) / scale,
      footSeparation: dist3(ankle, otherAnkle) / scale,
      legVectorX: (ankle.x - hip.x) / scale,
      legVectorY: (ankle.y - hip.y) / scale,
      legVectorZ: ((ankle.z ?? 0) - (hip.z ?? 0)) / scale,
      flagAnkleSpeed: side === "left" ? frame.leftAnkleV : frame.rightAnkleV,
      supportAnkleSpeed: side === "left" ? frame.rightAnkleV : frame.leftAnkleV,
      bodySpeed: frame.bodyV,
      anchorHandSpeed: Math.min(frame.leftWristV, frame.rightWristV),
      engaged: frame.lw.y < frame.ls.y + .18 || frame.rw.y < frame.rs.y + .18,
    };
  }));
}

type FlagTrajectoryAxis = "lateralReach" | "depthReach" | "footSeparation";
const FLAG_TRAJECTORY_AXES: ReadonlyArray<{ key: FlagTrajectoryAxis; extension: number; resolution: number; minimumPeak: number }> = [
  { key: "lateralReach", extension: .08, resolution: .045, minimumPeak: .16 },
  { key: "depthReach", extension: .16, resolution: .10, minimumPeak: .30 },
  { key: "footSeparation", extension: .15, resolution: .10, minimumPeak: .28 },
];

function visibleLegAcceleration(first: IntentionalFlagSample, middle: IntentionalFlagSample, last: IntentionalFlagSample) {
  const firstDt = middle.time - first.time;
  const secondDt = last.time - middle.time;
  if (firstDt <= 0 || secondDt <= 0) return Number.POSITIVE_INFINITY;
  const firstVx = (middle.legVectorX - first.legVectorX) / firstDt;
  const firstVy = (middle.legVectorY - first.legVectorY) / firstDt;
  const secondVx = (last.legVectorX - middle.legVectorX) / secondDt;
  const secondVy = (last.legVectorY - middle.legVectorY) / secondDt;
  return Math.hypot(secondVx - firstVx, secondVy - firstVy) / ((firstDt + secondDt) / 2);
}

function findPurposefulFlagIntervals(side: "left" | "right", trace: IntentionalFlagSample[]) {
  const candidates: IntentionalFlagInterval[] = [];
  for (const axis of FLAG_TRAJECTORY_AXES) {
    for (let startIndex = 0; startIndex < trace.length - 4; startIndex += 1) {
      const start = trace[startIndex];
      if (!start) continue;
      for (let peakIndex = startIndex + 2; peakIndex < trace.length - 2; peakIndex += 1) {
        const peak = trace[peakIndex];
        if (!peak || peak.time - start.time > 1.4) break;
        if (peak[axis.key] < axis.minimumPeak || peak[axis.key] - start[axis.key] < axis.extension) continue;
        if (peak.legReach < .32 || peak.footSeparation < .14 || (peak.lateralReach < .16 && peak.depthReach < .10)) continue;

        const extension = trace.slice(startIndex, peakIndex + 1);
        const outwardSteps = extension.slice(1).filter((sample, index) => sample[axis.key] >= (extension[index]?.[axis.key] ?? sample[axis.key]) - .035).length;
        if (outwardSteps / Math.max(1, extension.length - 1) < .75) continue;

        for (let resolutionIndex = peakIndex + 2; resolutionIndex < trace.length; resolutionIndex += 1) {
          const resolution = trace[resolutionIndex];
          if (!resolution || resolution.time - peak.time > 1.5) break;
          if (peak[axis.key] - resolution[axis.key] < axis.resolution) continue;
          const returnTrace = trace.slice(peakIndex, resolutionIndex + 1);
          const returningSteps = returnTrace.slice(1).filter((sample, index) => sample[axis.key] <= (returnTrace[index]?.[axis.key] ?? sample[axis.key]) + .035).length;
          if (returningSteps / Math.max(1, returnTrace.length - 1) < .75) continue;

          const gesture = trace.slice(startIndex, resolutionIndex + 1);
          const engagedRatio = gesture.filter((sample) => sample.engaged).length / gesture.length;
          const controlledBodyRatio = gesture.filter((sample) => sample.bodySpeed < .38).length / gesture.length;
          const plantedSupportRatio = gesture.filter((sample) => sample.supportAnkleSpeed < .55).length / gesture.length;
          const anchoredHandRatio = gesture.filter((sample) => sample.anchorHandSpeed < .38).length / gesture.length;
          const accelerations = gesture.slice(2).map((sample, index) => {
            const first = gesture[index], middle = gesture[index + 1];
            return first && middle ? visibleLegAcceleration(first, middle, sample) : Number.POSITIVE_INFINITY;
          });
          const smoothRatio = accelerations.filter((acceleration) => acceleration < 3.5).length / Math.max(1, accelerations.length);
          const peakAcceleration = accelerations.length ? Math.max(...accelerations) : Number.POSITIVE_INFINITY;

          // A flag must be a complete, smooth out-and-back gesture. In Jon's
          // exported slip the foot jumps abruptly while the body is moving;
          // accepting only controlled low-acceleration traces keeps that slip
          // visible to the foot-cut detector. The support-foot threshold is
          // deliberately tolerant of MediaPipe jitter, but every chronological
          // sample remains in the trace and contributes to these ratios.
          if (engagedRatio >= .75
            && controlledBodyRatio >= .75
            && plantedSupportRatio >= .55
            && anchoredHandRatio >= .75
            && resolution.flagAnkleSpeed < .65
            && smoothRatio >= .75
            && peakAcceleration < 5.5) {
            candidates.push({ side, start: start.time, end: resolution.time });
            break;
          }
        }
      }
    }
  }

  const merged: IntentionalFlagInterval[] = [];
  for (const candidate of candidates.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start <= previous.end) previous.end = Math.max(previous.end, candidate.end);
    else merged.push({ ...candidate });
  }
  return merged;
}

/**
 * Finds deliberate flags from the complete chronological trace. A flag must
 * show a contiguous, smooth extension and controlled return with one support
 * foot planted; isolated qualifying frames, long gaps, static silhouettes and
 * sudden slip-like jerks never suppress a foot-cut event.
 */
export function detectIntentionalFlagIntervals(samples: IntentionalFlagSample[]): IntentionalFlagInterval[] {
  const intervals: IntentionalFlagInterval[] = [];
  for (const side of ["left", "right"] as const) {
    const sideSamples = samples.filter((sample) => sample.side === side).sort((a, b) => a.time - b.time);
    let trace: IntentionalFlagSample[] = [];
    const finish = () => {
      if (trace.length >= 5) intervals.push(...findPurposefulFlagIntervals(side, trace));
      trace = [];
    };
    for (const sample of sideSamples) {
      const previous = trace[trace.length - 1];
      // The normal detector cadence is 240 ms. A 380 ms ceiling tolerates
      // minor scheduling jitter without bridging a missing 0.82 s span.
      if (previous && (sample.time <= previous.time || sample.time - previous.time > .38)) finish();
      trace.push(sample);
    }
    finish();
  }
  return intervals.sort((a, b) => a.start - b.start);
}

function suppressIntentionalFlagFootCuts(firings: Firing[], frames: RichFrame[]) {
  const samples = flagSamples(frames);
  const flags = detectIntentionalFlagIntervals(samples);
  if (!flags.length) return firings;
  return firings.filter((firing) => firing.rule !== "foot_cut" || !flags.some((flag) => {
    if (firing.side === "center") return false;
    const overlapsObservedFlag = firing.start <= flag.end && firing.end >= flag.start && firing.start >= flag.start - .25;
    if (!overlapsObservedFlag) return false;
    if (firing.side === flag.side) return firing.peak >= flag.start && firing.peak <= flag.end;
    if (firing.side !== "both") return false;
    const peakFrame = frames.reduce<RichFrame | null>((nearest, frame) => !nearest || Math.abs(frame.time - firing.peak) < Math.abs(nearest.time - firing.peak) ? frame : nearest, null);
    if (peakFrame && peakFrame.leftAnkleV > .55 && peakFrame.rightAnkleV > .55) return false;
    // MediaPipe can mark a controlled flag as a paired release when the
    // planted foot jitters for one sample. Suppress that only when the full
    // smooth flag gesture exists and its support foot is still controlled at
    // the event peak. Genuine two-foot cuts and the exported slip fail this.
    const overlapTarget = Math.min(flag.end, Math.max(flag.start, firing.peak));
    const supportAtPeak = samples
      .filter((sample) => sample.side === flag.side && sample.time >= flag.start && sample.time <= flag.end)
      .reduce<IntentionalFlagSample | null>((nearest, sample) => !nearest || Math.abs(sample.time - overlapTarget) < Math.abs(nearest.time - overlapTarget) ? sample : nearest, null);
    return Boolean(supportAtPeak && supportAtPeak.supportAnkleSpeed < .55);
  }));
}

function pogoHasSignificantBodyDisplacement(pogo: PogoInterval, frames: RichFrame[]) {
  const segment = frames.filter((frame) => frame.time >= pogo.start && frame.time <= pogo.end);
  const origin = segment[0];
  if (!origin || segment.length < 2) return false;
  const maximumBodyTravel = segment.reduce((maximum, frame) => {
    const scale = Math.max(.28, (origin.bodyScale + frame.bodyScale) / 2);
    const displacement = (dist(origin.hip, frame.hip) + dist(origin.shoulder, frame.shoulder)) / (2 * scale);
    return Math.max(maximum, displacement);
  }, 0);
  return maximumBodyTravel >= TUNING.staticPullBodyTravel;
}

function suppressIntentionalPogoSignals(firings: Firing[], frames: RichFrame[]) {
  const pogos = detectPogoIntervals(frames);
  if (!pogos.length) return firings;
  const transientPogoRules = new Set<CueCode>(["bent_arms", "barn_door", "foot_cut", "sloppy_feet", "square_reach", "sagging_hips"]);
  return firings.filter((firing) => !transientPogoRules.has(firing.rule) || !pogos.some((pogo) => {
    // A two-foot release is tension loss, never an intentional one-leg pogo.
    if (firing.rule === "foot_cut" && (firing.side === "both" || firing.side === "center")) return false;
    if (firing.rule === "foot_cut") {
      const leadIn = frames.filter((frame) => frame.time >= pogo.start && frame.time <= pogo.start + .5);
      const controlledLeadInRatio = leadIn.filter((frame) => frame.bodyV < .55).length / Math.max(1, leadIn.length);
      // A pogo gathers from a controlled setup before the dynamic launch. A
      // slip is already a body jerk at onset, so it must remain a foot cut.
      if (leadIn.length < 2 || controlledLeadInRatio < 2 / 3) return false;
    }
    // Bent arms are suppressed only when the climber's body travels through
    // the pogo. An ankle-only fidget during a static over-hold can satisfy the
    // broad pogo classifier, but it must not erase the sustained arm load.
    if (firing.rule === "bent_arms" && !pogoHasSignificantBodyDisplacement(pogo, frames)) return false;
    // A verified moving-body pogo/jump makes the transient elbow load dynamic
    // regardless of which arm is bent; tying bent-arm suppression to the
    // moving foot's side caused the exported foot-switch jump to regress.
    const sideRelevant = firing.side === pogo.side
      || firing.rule === "bent_arms"
      || firing.rule === "square_reach"
      || firing.rule === "sagging_hips";
    const peakInsideSwing = firing.peak >= pogo.start - .18 && firing.peak <= pogo.end + .18;
    return sideRelevant && pogo.end - pogo.start >= .45 && peakInsideSwing;
  }));
}

function suppressBoundarySignals(firings: Firing[], frames: RichFrame[]) {
  if (!frames.length) return firings;
  // Setup before the first move and stepping down after a top-out are session
  // boundaries, not technique faults. Require a short run of engaged samples
  // so a raised hand before the climber is weighted on the wall is not enough.
  const handsEngaged = (frame: RichFrame) => frame.lw.y < frame.ls.y + .18 || frame.rw.y < frame.rs.y + .18;
  const movingOnWall = (frame: RichFrame) => {
    const movement = Math.max(frame.bodyV, frame.leftWristV, frame.rightWristV, frame.leftAnkleV, frame.rightAnkleV);
    const oneFootControlled = Math.min(frame.leftAnkleV, frame.rightAnkleV) < .35;
    const oneHandAnchored = Math.min(frame.leftWristV, frame.rightWristV) < .45;
    return handsEngaged(frame) && oneFootControlled && oneHandAnchored && frame.bodyV < .55 && movement > .075;
  };
  let firstActiveIndex = -1;
  for (let index = 0; index < frames.length - 2; index += 1) {
    const sequence = frames.slice(index, index + 3);
    const first = sequence[0], last = sequence[2];
    if (!first || !last || last.time - first.time > .75) continue;
    const handsLoaded = sequence.every(handsEngaged);
    const supportRatio = sequence.filter((frame) => Math.min(frame.leftAnkleV, frame.rightAnkleV) < .35).length / sequence.length;
    const anchoredHandRatio = sequence.filter((frame) => Math.min(frame.leftWristV, frame.rightWristV) < .45).length / sequence.length;
    const controlledBodyRatio = sequence.filter((frame) => frame.bodyV < .55).length / sequence.length;
    const hasClimbingDisplacement = sequence.some(movingOnWall);
    if (handsLoaded && supportRatio >= 2 / 3 && anchoredHandRatio >= 2 / 3 && controlledBodyRatio >= 2 / 3 && hasClimbingDisplacement) {
      firstActiveIndex = index;
      break;
    }
  }
  const climbStart = firstActiveIndex >= 0 ? (frames[firstActiveIndex]?.time ?? 0) : 0;

  // A dismount has a sustained downward hip displacement, a body-speed spike,
  // and hands releasing near the end of the clip. Backdate the boundary to the
  // start of that drop so the first step-off frame is also excluded.
  let dismountStart = Number.POSITIVE_INFINITY;
  const searchFrom = Math.max(firstActiveIndex + 3, Math.floor(frames.length * .38));
  for (let index = searchFrom; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    const before = frames.filter((sample) => sample.time >= frame.time - .9 && sample.time <= frame.time);
    const after = frames.filter((sample) => sample.time >= frame.time && sample.time <= frame.time + .9);
    if (before.length < 3 || after.length < 2) continue;
    const highHipY = Math.min(...before.map((sample) => sample.hip.y));
    const hipDrop = frame.hip.y - highHipY;
    const bodySpike = Math.max(...before.map((sample) => sample.bodyV), ...after.map((sample) => sample.bodyV));
    const movingDown = before.some((sample) => sample.hipUpV < -.12) || after.some((sample) => sample.hipUpV < -.12);
    const releasedHandsRatio = after.filter((sample) => !handsEngaged(sample)).length / after.length;
    const clearDropAway = hipDrop >= .20 && bodySpike >= .70;
    if (hipDrop >= .105 && bodySpike >= .28 && movingDown && (releasedHandsRatio >= .34 || clearDropAway)) {
      const onset = before.find((sample) => sample.hip.y <= highHipY + .025);
      dismountStart = onset?.time ?? frame.time;
      break;
    }
  }
  const endBoundary = dismountStart;
  return firings.filter((firing) => {
    if (firing.rule !== "sagging_hips" && firing.rule !== "foot_cut") return true;
    const nearest = frames.reduce<RichFrame | null>((best, sample) => !best || Math.abs(sample.time - firing.peak) < Math.abs(best.time - firing.peak) ? sample : best, null);
    if (firstActiveIndex < 0) {
      // No sustained, controlled on-wall sequence was found. This is the
      // signature in the exported pre-climb label: limbs move quickly while
      // the climber is setting up, but no planted-foot/anchored-hand sequence
      // ever establishes a climb. Do not turn that boundary motion into a cut.
      if (firing.rule === "foot_cut") return false;
      if (nearest && !handsEngaged(nearest)) return false;
    }
    if (firing.peak < Math.max(0, climbStart - .1)) return false;
    return firing.peak < endBoundary - .12;
  });
}

function detectDismountEvents(frames: RichFrame[]): DismountEvent[] {
  if (frames.length < 7) return [];
  const events: DismountEvent[] = [];
  const handsEngaged = (frame: RichFrame) => frame.lw.y < frame.ls.y + .18 || frame.rw.y < frame.rs.y + .18;
  for (let index = Math.max(3, Math.floor(frames.length * .28)); index < frames.length - 2; index += 1) {
    const frame = frames[index];
    if (!frame || events.some((event) => frame.time * 1000 - event.peak_ms < 2200)) continue;
    const before = frames.filter((sample) => sample.time >= frame.time - 1.15 && sample.time <= frame.time);
    const after = frames.filter((sample) => sample.time >= frame.time && sample.time <= frame.time + .9);
    if (before.length < 3 || after.length < 2) continue;
    const settledFeet = before.filter((sample) => sample.leftAnkleV < .34 && sample.rightAnkleV < .34).length / before.length;
    const engagedHands = before.filter(handsEngaged).length / before.length;
    if (settledFeet < .45 || engagedHands < .45) continue;
    const baseline = before[0];
    if (!baseline) continue;
    const hipDrop = Math.max(...after.map((sample) => (sample.hip.y - baseline.hip.y) / Math.max(.28, sample.bodyScale)), 0);
    const bodySpike = Math.max(...after.map((sample) => sample.bodyV), 0);
    const downward = after.filter((sample) => sample.hipUpV < -.2).length >= Math.min(2, after.length);
    const feetReleased = after.some((sample) => sample.leftAnkleV > .48 && sample.rightAnkleV > .48);
    if (hipDrop < .12 || bodySpike < .55 || !downward || !feetReleased) continue;

    const peak = after.reduce((best, sample) => sample.bodyV > best.bodyV ? sample : best, after[0] ?? frame);
    const shoulderRotation = Math.max(...after.map((sample) => angleDelta(sample.shoulderLine, baseline.shoulderLine)), 0);
    const limbSplay = Math.max(...after.map((sample) => (
      dist(sample.lw, sample.rw) + dist(sample.la, sample.ra)
      - dist(baseline.lw, baseline.rw) - dist(baseline.la, baseline.ra)
    ) / Math.max(.28, sample.bodyScale)), 0);
    const asymmetry = Math.max(...after.map((sample) => Math.abs(sample.leftAnkleV - sample.rightAnkleV) + Math.abs(sample.leftWristV - sample.rightWristV)), 0);
    const releaseRatio = after.filter((sample) => !handsEngaged(sample)).length / after.length;
    const topPosition = before.slice(-3).filter((sample) => sample.lw.y < sample.ls.y - .08 && sample.rw.y < sample.rs.y - .08).length >= 2;
    const final = after[after.length - 1] ?? peak;
    const upright = Math.abs(final.shoulder.x - final.hip.x) / Math.max(.28, final.bodyScale) < .22;
    const feetUnder = Math.abs(final.ankle.x - final.hip.x) / Math.max(.28, final.bodyScale) < .34 && final.ankle.y > final.hip.y;
    const controlledArc = shoulderRotation < 22 && limbSplay < .28 && asymmetry < 1.35;

    const fallScore = (bodySpike > 1.05 ? 1 : 0) + (limbSplay > .3 ? 1 : 0) + (shoulderRotation > 28 ? 1 : 0) + (asymmetry > 1.45 ? 1 : 0) + (releaseRatio > .55 && !topPosition ? 1 : 0);
    const controlledScore = (topPosition ? 1 : 0) + (upright ? 1 : 0) + (feetUnder ? 1 : 0) + (controlledArc ? 1 : 0) + (releaseRatio > .45 ? 1 : 0);
    const classification: DismountClassification = controlledScore >= 4 && controlledScore > fallScore + 1 ? "likely_controlled_dismount" : "likely_fall";
    const signals = classification === "likely_fall"
      ? [bodySpike > 1.05 ? "sudden downward acceleration" : "downward acceleration", limbSplay > .3 ? "limbs splayed" : "feet released", shoulderRotation > 28 ? "uncontrolled rotation" : "tension released"]
      : [topPosition ? "top-position hands" : "hands released together", upright ? "upright body" : "steady torso", feetUnder ? "feet swung underneath" : "controlled arc"];
    const confidence = Math.min(.92, .56 + Math.abs(fallScore - controlledScore) * .08);
    events.push({
      start_ms: Math.max(0, Math.round((peak.time - .35) * 1000)),
      end_ms: Math.round((peak.time + .7) * 1000),
      peak_ms: Math.round(peak.time * 1000),
      classification,
      confidence,
      signals: [...new Set(signals)],
    });
  }
  return events;
}

export type HesitationMotionSample = {
  time: number;
  reliable: boolean;
  handsEngaged: boolean;
  limbsTracked: boolean;
  hipV: number;
  leftKneeV: number;
  rightKneeV: number;
  leftElbowV: number;
  rightElbowV: number;
};

/**
 * Finds a sustained pause without a major hip, knee, or elbow move after
 * climbing motion has begun. The opening two seconds are observation-only, so
 * a climber setting up on the wall cannot trigger the cue. A detected dismount
 * boundary ends observation.
 */
export function detectHesitationIntervals(
  samples: HesitationMotionSample[],
  dismountStartSeconds = Number.POSITIVE_INFINITY,
) {
  const intervals: Array<{ start: number; end: number; peak: number }> = [];
  let climbActive = false,
    quietStart: number | null = null,
    quietSamples = 0,
    firingIndex: number | null = null,
    lastFired = Number.NEGATIVE_INFINITY,
    previousTime: number | null = null;

  for (const sample of samples) {
    const motion = Math.max(
      sample.hipV,
      sample.leftKneeV,
      sample.rightKneeV,
      sample.leftElbowV,
      sample.rightElbowV,
    );
    const fullyTrackedOnWall = sample.reliable && sample.limbsTracked && sample.handsEngaged;
    if (fullyTrackedOnWall && motion > .12) climbActive = true;

    if (!climbActive || sample.time < 2 || sample.time >= dismountStartSeconds) {
      quietStart = null;
      quietSamples = 0;
      firingIndex = null;
      previousTime = sample.time;
      continue;
    }

    const sampleGap = previousTime === null ? 0 : sample.time - previousTime;
    previousTime = sample.time;
    const noMajorMove = sampleGap <= .85 && fullyTrackedOnWall
      && motion < TUNING.hesitationMajorMoveSpeed;
    if (!noMajorMove) {
      quietStart = null;
      quietSamples = 0;
      firingIndex = null;
      continue;
    }

    if (quietStart === null) quietStart = sample.time;
    quietSamples += 1;
    if (firingIndex === null && quietSamples >= 4 && sample.time - quietStart >= TUNING.hesitationStillnessSeconds && sample.time - lastFired >= 4) {
      intervals.push({ start: quietStart, end: sample.time, peak: sample.time });
      firingIndex = intervals.length - 1;
      lastFired = sample.time;
    } else if (firingIndex !== null) {
      const interval = intervals[firingIndex];
      if (interval) interval.end = sample.time;
    }
  }
  return intervals;
}

function suppressSaggingHipsDuringDismounts(firings: Firing[], dismounts: DismountEvent[]) {
  const dismountStartSeconds = dismounts.reduce(
    (earliest, event) => Math.min(earliest, event.start_ms / 1000),
    Number.POSITIVE_INFINITY,
  );
  return firings.filter((firing) => firing.rule !== "sagging_hips" || firing.peak < dismountStartSeconds);
}

function detectHesitationEvents(frames: RichFrame[], dismounts: DismountEvent[]): CueEvent[] {
  const dismountStartSeconds = dismounts.reduce(
    (earliest, event) => Math.min(earliest, event.start_ms / 1000),
    Number.POSITIVE_INFINITY,
  );
  const samples = frames.map((frame): HesitationMotionSample => ({
    time: frame.time,
    reliable: frame.reliable,
    handsEngaged: frame.lw.y < frame.ls.y + .18 || frame.rw.y < frame.rs.y + .18,
    limbsTracked: visible(frame.lms, [13, 14, 23, 24, 25, 26], .28),
    hipV: frame.hipV,
    leftKneeV: frame.leftKneeV,
    rightKneeV: frame.rightKneeV,
    leftElbowV: frame.leftElbowV,
    rightElbowV: frame.rightElbowV,
  }));
  return detectHesitationIntervals(samples, dismountStartSeconds).map((interval) => ({
    code: "hesitation",
    title: RULES.hesitation.title,
    suggestion: RULES.hesitation.cue,
    severity: 1,
    duration_ms: Math.round((interval.end - interval.start) * 1000),
    start_ms: Math.round(interval.start * 1000),
    end_ms: Math.round(interval.end * 1000),
    peak_ms: Math.round(interval.peak * 1000),
    joint_name: "hips",
    side: "center",
    is_fused: false,
    coaching_note: "A deliberate shakeout can look the same, so treat this as a nudge rather than a hard fault.",
  }));
}

const TUNING = {
  hesitationStillnessSeconds: .5,
  hesitationMajorMoveSpeed: .30,
  engagedWristShoulderOffset: .18,
  settledFootSpeed: .30,
  reachWindowSeconds: .9,
  minimumReachBodyLengths: .30,
  minimumReachElbowDegrees: 118,
  minimumReachSamples: 3,
  minimumReachTravel: .075,
  minimumReachExtensionGain: .025,
  reachVsSupportTravelRatio: 1.08,
  frontalShoulderDepth: .18,
  frontalHipDepth: .14,
  squareShoulderSpan: .20,
  squareHipSpan: .10,
  squareLineDeltaDegrees: 24,
  pullWindowSeconds: .75,
  staticPullBodySpeed: .16,
  staticPullBodyTravel: .10,
  staticPullVerticalSpeed: .12,
  bentElbowDegrees: 130,
  bentConfidenceRange: 55,
  bentConfidenceBase: .25,
  sagHipDepth: .045,
  sagHipPerp2D: .12,
  sagHipOffset: .125,
  sagConfidenceDepthBase: .025,
  sagConfidenceDepthRange: .18,
  sagConfidenceOffsetBase: .08,
  sagConfidenceOffsetRange: .2,
  // A turned hip can move laterally in the camera without leaving the wall.
  // Require clear geometric separation and ignore borderline per-frame noise.
  sagConfidenceFloor: .35,
  highFootHipOffset: .42,
  squareReachConfidenceBase: .27,
  squareReachConfidenceRange: .28,
  squareReachConfidenceFloor: .2,
  rotationWindowSeconds: 1.9,
  looseFootSpeed: .32,
  priorStableFootSpeed: .20,
  footBurstSpeed: .18,
  recentFootSamples: 5,
  sharpFootSpeed: .38,
  sharpOtherFootSpeed: .24,
  barnDoorRotationRate: 32,
  barnDoorWristSpeed: .16,
  barnDoorConfidenceRotationBase: 22,
  barnDoorConfidenceRotationRange: 85,
  anchoredHandSpeed: .38,
  clearFootReleaseSpeed: .28,
  footCutConfidenceRange: .75,
  pairedReleaseConfidence: .18,
  singleReleaseConfidence: .08,
  idleWindowSeconds: 7,
  idleMinimumSamples: 12,
  idleHandBurstSpeed: .22,
  idleFootBurstSpeed: .17,
  idleMinimumHandBursts: 3,
  idleConfidenceBase: .45,
  idleConfidenceStep: .16,
} as const;

function evaluate(f:RichFrame,history:RichFrame[],prev:RichFrame|null):Partial<Record<CueCode,Signal>>{
  const out:Partial<Record<CueCode,Signal>>={}; if(!f.reliable)return out;
  const wristHigh=f.lw.y < f.ls.y + TUNING.engagedWristShoulderOffset || f.rw.y < f.rs.y + TUNING.engagedWristShoulderOffset,footStable=f.leftAnkleV < TUNING.settledFootSpeed && f.rightAnkleV < TUNING.settledFootSpeed;
  const leftBent=f.leftElbow<f.rightElbow,elbowMin=Math.min(f.leftElbow,f.rightElbow),elbowMax=Math.max(f.leftElbow,f.rightElbow);
  const reachLeft=dist(f.ls,f.lw)>=dist(f.rs,f.rw),reachArm=Math.max(dist(f.ls,f.lw),dist(f.rs,f.rw))/f.bodyScale;
  const reachWindow=recent(history, TUNING.reachWindowSeconds, f.time),reachSide: "lw" | "rw"=reachLeft?"lw":"rw",supportSide: "lw" | "rw"=reachLeft?"rw":"lw";
  const reachTravel=pathLength(reachWindow,reachSide),supportTravel=pathLength(reachWindow,supportSide);
  const extensionGain=reachWindow.length>=2?reachArm-Math.min(...reachWindow.map((sample)=>Math.max(dist(sample.ls,sample.lw),dist(sample.rs,sample.rw))/sample.bodyScale)):0;
  const longReach=reachArm > TUNING.minimumReachBodyLengths && elbowMax > TUNING.minimumReachElbowDegrees,reachingMotion=reachWindow.length >= TUNING.minimumReachSamples && reachTravel > TUNING.minimumReachTravel && extensionGain > TUNING.minimumReachExtensionGain && reachTravel > supportTravel * TUNING.reachVsSupportTravelRatio;
  const shoulderDepthDelta=Math.abs((f.ls.z??0)-(f.rs.z??0))/f.bodyScale,hipDepthDelta=Math.abs((f.lh.z??0)-(f.rh.z??0))/f.bodyScale;
  const frontalTorso=shoulderDepthDelta < TUNING.frontalShoulderDepth && hipDepthDelta < TUNING.frontalHipDepth;
  const square=frontalTorso&&f.shoulderSpan / f.bodyScale > TUNING.squareShoulderSpan && f.hipSpan / f.bodyScale > TUNING.squareHipSpan && angleDelta(f.shoulderLine, f.hipLine) < TUNING.squareLineDeltaDegrees;
  // Bent elbows are only a fault when they load without useful body travel.
  // Dynamic pulls often pass through acute elbow angles, so angle alone must
  // not create a locked-arm event.
  const pullWindow=recent(history, TUNING.pullWindowSeconds, f.time);
  const averageBodySpeed=pullWindow.length?pullWindow.reduce((sum,sample)=>sum+sample.bodyV,0)/pullWindow.length:f.bodyV;
  const bodyTravel=pullWindow.length>=2
    ? (dist(pullWindow[0]?.hip??f.hip,pullWindow[pullWindow.length-1]?.hip??f.hip)+dist(pullWindow[0]?.shoulder??f.shoulder,pullWindow[pullWindow.length-1]?.shoulder??f.shoulder))/(2*f.bodyScale)
    : 0;
  const staticPull=pullWindow.length<2||(averageBodySpeed < TUNING.staticPullBodySpeed && bodyTravel < TUNING.staticPullBodyTravel && Math.abs(f.hipUpV) < TUNING.staticPullVerticalSpeed);
  if(wristHigh&&footStable&&staticPull&&elbowMin < TUNING.bentElbowDegrees)out.bent_arms={confidence:clamp((TUNING.bentElbowDegrees - elbowMin) / TUNING.bentConfidenceRange + TUNING.bentConfidenceBase),side:leftBent?"left":"right",joint:"elbow"};
  // MediaPipe depth gets smaller toward the camera. Hips that peel away from
  // the wall therefore sit in front of the shoulder-to-foot plane. A 2D
  // shoulder-to-ankle axis supplies the complementary signal for side views,
  // where the estimated z-depth may barely change.
  const hipDepth=(((f.shoulder.z??0)+(f.ankle.z??0))/2)-(f.hip.z??0),hipOffset=Math.abs(f.hip.x-(f.shoulder.x+f.ankle.x)/2)/f.bodyScale;
  const hipPerp2D=normalizedPointLineDistance2D(f.hip,f.shoulder,f.ankle);
  const sagDepthConfidence=(hipDepth - TUNING.sagConfidenceDepthBase) / TUNING.sagConfidenceDepthRange;
  const sagOffsetConfidence=hipOffset > TUNING.sagHipOffset?(hipOffset - TUNING.sagConfidenceOffsetBase) / TUNING.sagConfidenceOffsetRange:0;
  const sagPerp2DConfidence=hipPerp2D > TUNING.sagHipPerp2D
    ? TUNING.sagConfidenceFloor + (hipPerp2D - TUNING.sagHipPerp2D) / TUNING.sagConfidenceOffsetRange
    : 0;
  const sagConfidence=clamp(Math.max(sagDepthConfidence,sagOffsetConfidence,sagPerp2DConfidence));
  // Lateral x-offset alone is usually a flag, drop-knee, or hip turn—not hips
  // peeling away from the wall. It may strengthen a geometric signal but
  // never create one. A confidence floor also keeps borderline depth jitter
  // from accumulating into a false event across several samples.
  const sagGeometry=hipDepth > TUNING.sagHipDepth || hipPerp2D > TUNING.sagHipPerp2D;
  if(wristHigh&&sagGeometry&&sagConfidence >= TUNING.sagConfidenceFloor)out.sagging_hips={confidence:sagConfidence,side:"center",joint:"hips"};
  const highFoot=Math.min(f.la.y,f.ra.y)<f.hip.y + TUNING.highFootHipOffset;
  if(longReach&&reachingMotion&&square&&highFoot)out.square_reach={confidence:clamp((reachArm - TUNING.squareReachConfidenceBase) / TUNING.squareReachConfidenceRange + TUNING.squareReachConfidenceFloor),side:reachLeft?"left":"right",joint:"hip"};
  if(prev){const rotRate=angleDelta(f.shoulderLine,prev.shoulderLine)/f.dt,oneFootLoose=Math.max(f.leftAnkleV, f.rightAnkleV) > TUNING.looseFootSpeed;
    const window=recent(history, TUNING.rotationWindowSeconds, f.time).slice(0,-1),stable=[...window].reverse().find((x)=>x.leftAnkleV < TUNING.priorStableFootSpeed && x.rightAnkleV < TUNING.priorStableFootSpeed);
    const leftBurst=f.leftAnkleV > TUNING.footBurstSpeed, rightBurst = f.rightAnkleV > TUNING.footBurstSpeed,recentLeft=window.slice(-TUNING.recentFootSamples).some((x)=>x.leftAnkleV > TUNING.footBurstSpeed),recentRight=window.slice(-TUNING.recentFootSamples).some((x)=>x.rightAnkleV > TUNING.footBurstSpeed);
    const pairedRelease=(leftBurst&&rightBurst)||(leftBurst&&recentRight)||(rightBurst&&recentLeft);
    const sharpSingle=(f.leftAnkleV > TUNING.sharpFootSpeed && f.rightAnkleV < TUNING.sharpOtherFootSpeed)||(f.rightAnkleV > TUNING.sharpFootSpeed && f.leftAnkleV < TUNING.sharpOtherFootSpeed);
    if(rotRate > TUNING.barnDoorRotationRate && oneFootLoose && Math.max(f.leftWristV, f.rightWristV) > TUNING.barnDoorWristSpeed)out.barn_door={confidence:clamp((rotRate - TUNING.barnDoorConfidenceRotationBase) / TUNING.barnDoorConfidenceRotationRange + Math.max(f.leftAnkleV, f.rightAnkleV) / 2),side:f.leftAnkleV>=f.rightAnkleV?"left":"right",joint:"foot"};
    const anchoredHand=Math.min(f.leftWristV, f.rightWristV) < TUNING.anchoredHandSpeed;
    const clearRelease=Math.max(f.leftAnkleV, f.rightAnkleV) > TUNING.clearFootReleaseSpeed;
    const depart=Boolean(stable)&&(pairedRelease||sharpSingle||clearRelease);
    // A dynamic move is not automatically a clean dyno: if a stable foot
    // releases while a hand remains anchored, report it. Completed pogo
    // swings are removed later only after the foot visibly re-engages.
    if(depart&&anchoredHand){const side:Side=pairedRelease&&leftBurst&&rightBurst?"both":f.leftAnkleV>=f.rightAnkleV?"left":"right";out.foot_cut={confidence:clamp(Math.max(f.leftAnkleV, f.rightAnkleV) / TUNING.footCutConfidenceRange + (pairedRelease ? TUNING.pairedReleaseConfidence : TUNING.singleReleaseConfidence)),side,joint:"foot"};}
  }
  const moveWindow=recent(history, TUNING.idleWindowSeconds, f.time);if(moveWindow.length >= TUNING.idleMinimumSamples){const hands=bursts(moveWindow, "lw", TUNING.idleHandBurstSpeed)+bursts(moveWindow, "rw", TUNING.idleHandBurstSpeed),feet=bursts(moveWindow, "la", TUNING.idleFootBurstSpeed)+bursts(moveWindow, "ra", TUNING.idleFootBurstSpeed);if(hands >= TUNING.idleMinimumHandBursts&&feet===0)out.idle_feet={confidence:clamp(TUNING.idleConfidenceBase + (hands - TUNING.idleMinimumHandBursts) * TUNING.idleConfidenceStep),side:"both",joint:"feet"};}
  return out;
}

const DIAGNOSTIC_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32] as const;
const rounded = (value: number) => Number(value.toFixed(5));
function diagnosticFrame(frame: RichFrame, signals: Partial<Record<CueCode, Signal>>): DetectorDiagnosticFrame {
  const score = (code: CueCode) => rounded(signals[code]?.confidence ?? 0);
  const rawSignalScores: Partial<Record<CueCode, number>> = {};
  for (const code of Object.keys(signals) as CueCode[]) rawSignalScores[code] = score(code);
  const hipDepth = (((frame.shoulder.z ?? 0) + (frame.ankle.z ?? 0)) / 2) - (frame.hip.z ?? 0);
  const hipOffset = Math.abs(frame.hip.x - (frame.shoulder.x + frame.ankle.x) / 2) / frame.bodyScale;
  return {
    time_s: rounded(frame.time),
    reliable: frame.reliable,
    landmarks: DIAGNOSTIC_LANDMARKS.map((index) => {
      const landmark = point(frame.lms, index);
      return { index, x: rounded(landmark.x), y: rounded(landmark.y), z: rounded(landmark.z ?? 0), visibility: rounded(landmark.visibility ?? 1) };
    }),
    features: {
      left_elbow_deg: rounded(frame.leftElbow),
      right_elbow_deg: rounded(frame.rightElbow),
      hip_depth_body: rounded(hipDepth),
      hip_lateral_offset_body: rounded(hipOffset),
      left_ankle_speed: rounded(frame.leftAnkleV),
      right_ankle_speed: rounded(frame.rightAnkleV),
      ...(frame.leftAnkleFlex === null ? {} : { left_ankle_flex_deg: rounded(frame.leftAnkleFlex) }),
      ...(frame.rightAnkleFlex === null ? {} : { right_ankle_flex_deg: rounded(frame.rightAnkleFlex) }),
      left_wrist_speed: rounded(frame.leftWristV),
      right_wrist_speed: rounded(frame.rightWristV),
      hip_speed: rounded(frame.hipV),
      body_speed: rounded(frame.bodyV),
    },
    detector_scores: {
      foot_cut: score("foot_cut"),
      bent_arms: score("bent_arms"),
      sagging_hips: score("sagging_hips"),
      hesitation: 0,
    },
    raw_signal_scores: rawSignalScores,
  };
}

type PositiveCount = { successful: number; relevant: number };

const positivePoint = (frame: DetectorDiagnosticFrame, index: number) =>
  frame.landmarks.find((landmark) => landmark.index === index) ?? null;

function positivePointsVisible(frame: DetectorDiagnosticFrame, indexes: number[]) {
  return indexes.every((index) => (positivePoint(frame, index)?.visibility ?? 0) >= .34);
}

function positiveBodyScale(frame: DetectorDiagnosticFrame) {
  const leftShoulder = positivePoint(frame, 11), rightShoulder = positivePoint(frame, 12);
  const leftAnkle = positivePoint(frame, 27), rightAnkle = positivePoint(frame, 28);
  if (!leftShoulder || !rightShoulder || !leftAnkle || !rightAnkle) return null;
  const shoulderX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const ankleX = (leftAnkle.x + rightAnkle.x) / 2;
  const ankleY = (leftAnkle.y + rightAnkle.y) / 2;
  return Math.max(.28, Math.hypot(shoulderX - ankleX, shoulderY - ankleY));
}

function positiveWristEngaged(frame: DetectorDiagnosticFrame, side: "left" | "right") {
  const shoulder = positivePoint(frame, side === "left" ? 11 : 12);
  const wrist = positivePoint(frame, side === "left" ? 15 : 16);
  return Boolean(
    shoulder &&
    wrist &&
    (shoulder.visibility ?? 0) >= .34 &&
    (wrist.visibility ?? 0) >= .34 &&
    wrist.y < shoulder.y + .18,
  );
}

function positiveScore(
  code: PositiveTechniqueCode,
  title: string,
  count: PositiveCount,
  unit: PositiveTechniqueScore["unit"] = "moments",
): PositiveTechniqueScore {
  return {
    code,
    title,
    score: count.relevant
      ? Math.round((count.successful / count.relevant) * 100)
      : null,
    successful_samples: count.successful,
    relevant_samples: count.relevant,
    unit,
  };
}

type HandBurst = { start: number; end: number };
function handMotionBursts(
  frames: DetectorDiagnosticFrame[],
  side: "left" | "right",
): HandBurst[] {
  const speedKey = side === "left" ? "left_wrist_speed" : "right_wrist_speed";
  const bursts: HandBurst[] = [];
  let open: HandBurst | null = null;
  let quietSince: number | null = null;
  for (const frame of frames) {
    const tracked = frame.reliable && positiveWristEngaged(frame, side);
    const moving = tracked && frame.features[speedKey] >= .14;
    if (moving) {
      if (!open) open = { start: frame.time_s, end: frame.time_s };
      open.end = frame.time_s;
      quietSince = null;
      continue;
    }
    if (!open) continue;
    if (!tracked || frame.time_s - open.end > .55) {
      bursts.push(open);
      open = null;
      quietSince = null;
      continue;
    }
    quietSince ??= frame.time_s;
    if (frame.time_s - quietSince >= .28) {
      bursts.push(open);
      open = null;
      quietSince = null;
    }
  }
  if (open) bursts.push(open);
  return bursts;
}

function settledGripCount(frames: DetectorDiagnosticFrame[]): PositiveCount {
  const count: PositiveCount = { successful: 0, relevant: 0 };
  for (const side of ["left", "right"] as const) {
    const bursts = handMotionBursts(frames, side);
    let group: HandBurst[] = [];
    const finish = () => {
      if (!group.length) return;
      count.relevant += 1;
      if (group.length === 1) count.successful += 1;
      group = [];
    };
    for (const burst of bursts) {
      const previous = group[group.length - 1];
      if (previous && burst.start - previous.end > 1.25) finish();
      group.push(burst);
    }
    finish();
  }
  return count;
}

/**
 * Measures technique that is visibly present in the existing pose trace.
 * These ratios are independent observations: they never enter fault event
 * formation, detector thresholds, training labels, or movement deductions.
 */
export function scorePositiveTechnique(
  diagnostics: DetectorDiagnosticFrame[],
): PositiveTechniqueScore[] {
  const reliable = diagnostics.filter((frame) => frame.reliable);
  const hipTwist: PositiveCount = { successful: 0, relevant: 0 };
  const straightArms: PositiveCount = { successful: 0, relevant: 0 };
  const quietFeet: PositiveCount = { successful: 0, relevant: 0 };
  const closeHips: PositiveCount = { successful: 0, relevant: 0 };

  for (const frame of reliable) {
    const leftEngaged = positiveWristEngaged(frame, "left");
    const rightEngaged = positiveWristEngaged(frame, "right");
    const bodyMoving = frame.features.body_speed >= .08;

    if (bodyMoving) {
      if (leftEngaged) {
        straightArms.relevant += 1;
        if (frame.features.left_elbow_deg >= 150) straightArms.successful += 1;
      }
      if (rightEngaged) {
        straightArms.relevant += 1;
        if (frame.features.right_elbow_deg >= 150) straightArms.successful += 1;
      }
    }

    const leftReach = leftEngaged && frame.features.left_wrist_speed >= .16 && frame.features.left_wrist_speed > frame.features.right_wrist_speed * 1.15;
    const rightReach = rightEngaged && frame.features.right_wrist_speed >= .16 && frame.features.right_wrist_speed > frame.features.left_wrist_speed * 1.15;
    if ((leftReach || rightReach) && positivePointsVisible(frame, [23, 24])) {
      const leftHip = positivePoint(frame, 23), rightHip = positivePoint(frame, 24);
      const scale = positiveBodyScale(frame);
      if (leftHip && rightHip && scale) {
        hipTwist.relevant += 1;
        const reachingHipDepth = leftReach
          ? (leftHip.z - rightHip.z) / scale
          : (rightHip.z - leftHip.z) / scale;
        if (reachingHipDepth >= .025) hipTwist.successful += 1;
      }
    }

    if (
      (frame.features.left_wrist_speed >= .16 || frame.features.right_wrist_speed >= .16) &&
      positivePointsVisible(frame, [15, 16, 25, 26, 27, 28])
    ) {
      quietFeet.relevant += 1;
      if (frame.features.left_ankle_speed < .2 && frame.features.right_ankle_speed < .2) quietFeet.successful += 1;
    }

    if ((leftEngaged || rightEngaged) && positivePointsVisible(frame, [11, 12, 23, 24, 27, 28])) {
      closeHips.relevant += 1;
      if (frame.features.hip_depth_body <= TUNING.sagHipDepth) closeHips.successful += 1;
    }
  }

  return [
    positiveScore("hip_twist", "Hip twist on reaches", hipTwist),
    positiveScore("straight_arms", "Straight arms in motion", straightArms),
    positiveScore("quiet_feet", "Quiet feet on hand moves", quietFeet),
    positiveScore("settled_grips", "Settled grips", settledGripCount(reliable), "grips"),
    positiveScore("close_hips", "Hips close to wall", closeHips),
  ];
}

function states():Record<CueCode,RuleState>{return createEventStates(Object.keys(RULES) as CueCode[],"center");}
function process(signals:Partial<Record<CueCode,Signal>>,frame:RichFrame,state:Record<CueCode,RuleState>,firings:Firing[]){
  advanceEventStates(CORE_CUE_CODES,RULES,signals,{time:frame.time,dt:frame.dt},state,firings);
}

function cueEventFromFiring(firing:Firing):CueEvent{const cfg=RULES[firing.rule];const sideLabel=firing.side==="left"||firing.side==="right"?`${firing.side} `:"";return{code:firing.rule,title:`${sideLabel}${cfg.title}`.replace(/\b\w/g,(character)=>character.toUpperCase()),suggestion:cfg.cue,severity:Math.max(1,Math.min(5,Math.round(cfg.priority*.7+firing.confidence*1.5))),duration_ms:Math.round((firing.end-firing.start)*1000),start_ms:Math.round(firing.start*1000),end_ms:Math.round(firing.end*1000),peak_ms:Math.round(firing.peak*1000),joint_name:firing.joint,side:firing.side,is_fused:false};}
function atomicCueEvents(firings:Firing[]):CueEvent[]{return firings.map(cueEventFromFiring).sort((a,b)=>b.severity-a.severity||a.start_ms-b.start_ms);}

function hasDynoCommitment(frames: RichFrame[], releaseTime: number) {
  const window = frames.filter(
    (frame) => frame.time >= releaseTime - .24 && frame.time <= releaseTime + .28,
  );
  const upwardHipDrive = window.some((frame) => frame.hipUpV >= .15);
  const reachingHand = window.some(
    (frame) => Math.max(frame.leftWristV, frame.rightWristV) >= .18,
  );
  return upwardHipDrive && reachingHand;
}

function annotateKeepableFootCuts(cues: CueEvent[], frames: RichFrame[]): CueEvent[] {
  return cues.map((cue) => {
    if (cue.code !== "foot_cut") return cue;
    const peak = cue.peak_ms / 1000;
    const sides: LoadedFootSide[] =
      cue.side === "left" || cue.side === "right"
        ? [cue.side]
        : ["left", "right"];
    const flexReadings = sides
      .map((side) => averagePreReleaseAnkleFlex(frames, peak, side))
      .filter((value): value is number => value !== null);
    const engagedAnkle =
      flexReadings.length > 0 &&
      flexReadings.every((value) => value <= 130);
    const relaxedAnkle = flexReadings.some((value) => value >= 145);
    const dynoCommitment = hasDynoCommitment(frames, peak);
    const likelyControlled = engagedAnkle || dynoCommitment;

    let ghostFoot: CueEvent["ghost_foot"];
    if (cue.side === "left" || cue.side === "right") {
      const side = cue.side;
      const prior = frames
        .filter((frame) => frame.time >= peak - .95 && frame.time <= peak - .08)
        .sort((a, b) => a.time - b.time);
      const stable = prior.filter(
        (frame) =>
          isPositionallyLoadedFootSample(frame, side) &&
          footSpeed(frame, side) <= .32,
      );
      const stableStart = stable[0];
      const stableEnd = stable[stable.length - 1];
      const ghostFrame = stableEnd;
      const solidBeat = Boolean(
        stableStart &&
        stableEnd &&
        stable.length >= 3 &&
        stableEnd.time - stableStart.time >= .45,
      );
      if (solidBeat && ghostFrame) {
        const foot = side === "left" ? ghostFrame.la : ghostFrame.ra;
        const hipNow = frames.reduce<RichFrame | null>(
          (best, frame) =>
            !best || Math.abs(frame.time - peak) < Math.abs(best.time - peak)
              ? frame
              : best,
          null,
        )?.hip ?? ghostFrame.hip;
        ghostFoot = {
          x: foot.x,
          y: foot.y,
          side,
          hip_dx: hipNow.x - ghostFrame.hip.x,
          hip_dy: hipNow.y - ghostFrame.hip.y,
        };
      }
    }

    if (likelyControlled) {
      const evidence = dynoCommitment && engagedAnkle
        ? "Your ankle stayed engaged while your hips drove up and a hand reached."
        : dynoCommitment
          ? "Your hips drove up while a hand reached, which looks like a committed dyno."
          : "Your ankle stayed engaged through the release, which looks controlled.";
      return {
        ...cue,
        title: "Possible intentional foot cut",
        suggestion: "This may be a deliberate release. Confirm whether you cut on purpose or slipped.",
        severity: 1,
        coaching_note: evidence,
        ...(ghostFoot ? { ghost_foot: ghostFoot } : {}),
      };
    }

    return {
      ...cue,
      coaching_note: relaxedAnkle
        ? "Your ankle relaxed before the foot popped, with no committed upward move — this looks like tension loss."
        : "The foot popped without a committed upward move — this looks like tension loss.",
      ...(ghostFoot ? { ghost_foot: ghostFoot } : {}),
    };
  });
}

function fuse(firings:Firing[],frames:RichFrame[]):CueEvent[]{
  let active=[...firings],fused:CueEvent[]=[];
  const cuts=active.filter((f)=>f.rule==="foot_cut"),sags=active.filter((f)=>f.rule==="sagging_hips");
  const tensionCut=cuts.find((cut)=>sags.some((sag)=>cut.start<=sag.end+.75&&cut.end>=sag.start-.75));
  const tensionSag=tensionCut?sags.find((sag)=>tensionCut.start<=sag.end+.75&&tensionCut.end>=sag.start-.75):undefined;
  if(tensionCut&&tensionSag){const first=Math.min(tensionCut.start,tensionSag.start),last=Math.max(tensionCut.end,tensionSag.end);fused.push({code:"tension_chain",title:"Foot cut → tension loss",suggestion:"Keep driving through the cutting foot so your hips stay connected through the move.",severity:5,duration_ms:Math.round((last-first)*1000),start_ms:Math.round(first*1000),end_ms:Math.round(last*1000),peak_ms:Math.round(tensionCut.peak*1000),joint_name:"hips and feet",side:tensionCut.side,is_fused:true});active=active.filter((f)=>f!==tensionCut&&f!==tensionSag);}
  const foot=active.find((f)=>f.rule==="sloppy_feet");if(foot){const after=frames.filter((f)=>f.time>=foot.end+.25&&f.time<=foot.end+.95);if(after.some((f)=>f.hipV>.16)){const side=foot.side==="right"?"right":"left";fused.push({code:"late_weight_shift",title:`${side} foot weighted late`,suggestion:`Your ${side} foot is stable, but you're weighting it too late.`,severity:4,duration_ms:Math.round((foot.end-foot.start)*1000),start_ms:Math.round(foot.start*1000),end_ms:Math.round(foot.end*1000),peak_ms:Math.round(foot.peak*1000),joint_name:"foot and hips",side,is_fused:true});active=active.filter((f)=>f!==foot);}}
  return [...fused,...active.map(cueEventFromFiring)].sort((a,b)=>b.severity-a.severity||a.start_ms-b.start_ms);
}

function findStandout(frames: RichFrame[], cues: CueEvent[], totalFrames: number): StandoutNote | null {
  if (frames.length < 12 || frames.length / Math.max(1, totalFrames) < .65) return null;
  const isClearAt = (frame: RichFrame, codes: string[]) => {
    const timeMs = frame.time * 1000;
    return !cues.some((cue) => codes.includes(cue.code) && timeMs >= cue.start_ms - 250 && timeMs <= cue.end_ms + 250);
  };
  const engaged = frames.filter((frame) => frame.lw.y < frame.ls.y + .18 || frame.rw.y < frame.rs.y + .18);
  const longArms = engaged.filter((frame) => Math.min(frame.leftElbow, frame.rightElbow) >= 156 && isClearAt(frame, ["bent_arms"]));
  if (longArms.length >= 3) {
    let best = longArms[0];
    if (best) {
      for (const frame of longArms) if (Math.min(frame.leftElbow, frame.rightElbow) > Math.min(best.leftElbow, best.rightElbow)) best = frame;
      return { title: "Standout long-arm position", comment: "This was your cleanest long-arm moment: both elbows opened so your lower body could carry more of the load.", body_part: "both elbows", timestamp_ms: Math.round(best.time * 1000) };
    }
  }
  const activeHips = frames.filter((frame) => frame.hipV >= .18 && isClearAt(frame, ["sagging_hips", "square_reach", "tension_chain"]));
  if (activeHips.length >= 3) {
    let best = activeHips[0];
    if (best) {
      for (const frame of activeHips) if (frame.hipV > best.hipV) best = frame;
      return { title: "Standout hip movement", comment: "This was your strongest hip-driven moment: your center moved decisively instead of hanging under your hands.", body_part: "hips", timestamp_ms: Math.round(best.time * 1000) };
    }
  }
  const quietFeet = engaged.filter((frame) => frame.bodyV >= .06 && frame.leftAnkleV < .13 && frame.rightAnkleV < .13 && isClearAt(frame, ["foot_cut", "sloppy_feet", "idle_feet", "barn_door", "tension_chain", "late_weight_shift"]));
  if (quietFeet.length >= 3) {
    let best = quietFeet[0];
    if (best) {
      for (const frame of quietFeet) if (frame.bodyV > best.bodyV) best = frame;
      return { title: "Standout foot connection", comment: "Both feet stayed quiet while your body moved — a strong moment of tension through the footholds.", body_part: "both feet", timestamp_ms: Math.round(best.time * 1000) };
    }
  }
  return null;
}

async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  const duration = Number.isFinite(video.duration) ? video.duration : time + 0.1;
  const target = Math.min(Math.max(0, time), Math.max(0, duration - 0.04));
  video.pause();

  const attempt = (timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      let poll = 0;
      let timeout = 0;
      const cleanup = () => {
        window.clearInterval(poll);
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", check);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("canplay", check);
        video.removeEventListener("error", failed);
      };
      const check = () => {
        // Safari can omit `seeked` after many file-backed seeks. The decoder is
        // ready when it is no longer seeking, has a current frame, and landed
        // close to the requested timestamp, so polling is a safe fallback.
        if (
          !video.seeking &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          Math.abs(video.currentTime - target) < 0.1
        ) {
          cleanup();
          resolve();
        }
      };
      const failed = () => {
        cleanup();
        reject(new Error("Video frames could not be read."));
      };
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Video seek timed out."));
      }, timeoutMs);
      poll = window.setInterval(check, 50);
      video.addEventListener("seeked", check);
      video.addEventListener("loadeddata", check);
      video.addEventListener("canplay", check);
      video.addEventListener("error", failed, { once: true });
      if (Math.abs(video.currentTime - target) >= 0.015) video.currentTime = target;
      check();
    });

  try {
    await attempt(POSE_ANALYSIS_TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Video seek timed out.")
      throw error;
    // One retry handles a temporarily starved mobile decoder without making
    // every normal frame wait longer. Reassigning the same time also nudges
    // WebKit when it stopped emitting media events after an angle switch.
    video.currentTime = Math.max(0, target - 0.001);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    await attempt(18000);
  }

  await new Promise<void>((resolve) => {
    if ("requestVideoFrameCallback" in video) {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      video.requestVideoFrameCallback(() => finish());
      window.setTimeout(finish, 400);
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }
  });
}

export async function analyzeStillResult(image:HTMLImageElement, pose:any):Promise<{ cues: CueCode[]; tracking: TrackingQuality; diagnostics: DetectorDiagnosticFrame[] }> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Pose analysis timed out.")), POSE_ANALYSIS_TIMEOUT_MS);
    pose.onResults((result: any) => {
      clearTimeout(timer);
      const landmarks = result.poseLandmarks ?? null;
      if (!landmarks) return resolve({ cues: [], diagnostics: [], tracking: { poseFrames: 0, reliableFrames: 0, armTrackedFrames: 0, footTrackedFrames: 0, totalFrames: 1 } });
      const frame = extractFrame(landmarks, 0, null);
      // A still can validate only an unambiguous body shape. It cannot
      // establish a movement stall, and weak single-frame position scores are
      // too fragile to promote to events (the old path promoted 0.22).
      const evaluated = evaluate(frame, [frame], null);
      const stillMinimumScore = .75;
      const cues = CORE_CUE_CODES.filter((code) => code !== "hesitation" && (evaluated[code]?.confidence ?? 0) >= stillMinimumScore);
      resolve({ cues, diagnostics: [diagnosticFrame(frame, evaluated)], tracking: {
        poseFrames: 1,
        reliableFrames: frame.reliable ? 1 : 0,
        armTrackedFrames: visible(landmarks, [11, 12, 13, 14, 15, 16], .34) ? 1 : 0,
        footTrackedFrames: visible(landmarks, [23, 24, 25, 26, 27, 28], .34) ? 1 : 0,
        totalFrames: 1,
      } });
    });
    pose.send({ image }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("Pose analysis failed."));
    });
  });
}



export function resolveAnalysisDuration(videoDuration: number, durationHintSeconds?: number): number {
  if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;
  if (durationHintSeconds !== undefined && Number.isFinite(durationHintSeconds) && durationHintSeconds > 0) return durationHintSeconds;
  throw new Error("Video duration could not be determined.");
}

export function analyzeLandmarkTrace(trace: LandmarkTraceSample[], totalFrames = trace.length): AnalysisResult {
  const history: RichFrame[] = [], frames: RichFrame[] = [], diagnostics: DetectorDiagnosticFrame[] = [], firings: Firing[] = [], state = states();
  let prev: RichFrame | null = null, previousTraceTime: number | null = null, reliable = 0, poseFrames = 0, armTrackedFrames = 0, footTrackedFrames = 0;
  for (const sample of trace) {
    const { time, landmarks } = sample;
    if (landmarks) {
      poseFrames += 1;
      if (visible(landmarks, [11, 12, 13, 14, 15, 16], .34)) armTrackedFrames += 1;
      if (visible(landmarks, [23, 24, 25, 26, 27, 28], .34)) footTrackedFrames += 1;
      const frame = extractFrame(landmarks, time, prev);
      history.push(frame);
      if (history.length > 70) history.shift();
      if (frame.reliable) { reliable += 1; frames.push(frame); }
      const signals = evaluate(frame, history, prev);
      diagnostics.push(diagnosticFrame(frame, signals));
      // Keep the exported signal scores unchanged for Detector Check / Send to
      // Jett, but only form a foot-cut event when the pre-motion trace proves
      // that the moving foot had actually been loaded on the wall.
      process(gateFootCutSignal(signals, history, frame), frame, state, firings);
      prev = frame;
    } else {
      const dt = previousTraceTime === null ? .25 : Math.max(.04, time - previousTraceTime);
      advanceEventStates(CORE_CUE_CODES, RULES, {}, { time, dt }, state, firings);
    }
    previousTraceTime = time;
  }
  const dismounts = detectDismountEvents(frames);
  const bodyConfirmedFirings = suppressFootCutsWithoutBodyResponse(firings, frames);
  const boundarySafeFirings = suppressBoundarySignals(suppressIntentionalFlagFootCuts(suppressIntentionalPogoSignals(bodyConfirmedFirings, frames), frames), frames);
  const detectorFirings = suppressSaggingHipsDuringDismounts(boundarySafeFirings, dismounts);
  const hesitations = detectHesitationEvents(frames, dismounts);
  const detectorCues = [...annotateKeepableFootCuts(atomicCueEvents(detectorFirings), frames), ...hesitations]
    .sort((a, b) => a.peak_ms - b.peak_ms || b.severity - a.severity);
  const cues = [...annotateKeepableFootCuts(fuse(detectorFirings, frames), frames), ...hesitations]
    .sort((a, b) => b.severity - a.severity || a.start_ms - b.start_ms);
  return { cues, detectorCues, dismounts, frames, diagnostics, positiveScores: scorePositiveTechnique(diagnostics), totalFrames, reliableFrames: reliable, tracking: { poseFrames, reliableFrames: reliable, armTrackedFrames, footTrackedFrames, totalFrames }, standout: findStandout(frames, cues, totalFrames) };
}

// After-build detector grading entry point. Replays a frozen reference trace
// (sampled_frames from a detector-check export) through the current engine,
// mirroring exactly what the on-device detector check does: videos go through
// analyzeLandmarkTrace, stills through analyzeStillResult's pure path
// (single-frame evaluate with the 0.75 minimum score, temporal cues excluded).
// Purely additive; used by offline grading, never in the app UI.
export type GradingSample = {
  time_s: number;
  landmarks: Array<{ index: number; x: number; y: number; z?: number; visibility?: number }>;
};
export function gradeReferenceTrace(samples: GradingSample[], media: "video" | "image"): CueCode[] {
  const expand = (sparse: GradingSample["landmarks"]): Landmark[] => {
    const arr: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    for (const point of sparse) {
      if (point.index >= 0 && point.index < 33) {
        arr[point.index] = { x: point.x, y: point.y, z: point.z ?? 0, visibility: point.visibility ?? 0 };
      }
    }
    return arr;
  };
  if (media === "image") {
    const first = samples[0];
    if (!first) return [];
    const frame = extractFrame(expand(first.landmarks), 0, null);
    const evaluated = evaluate(frame, [frame], null);
    const stillMinimumScore = .75;
    return CORE_CUE_CODES.filter((code) => code !== "hesitation" && (evaluated[code]?.confidence ?? 0) >= stillMinimumScore);
  }
  const trace: LandmarkTraceSample[] = samples.map((sample) => ({ time: sample.time_s, landmarks: expand(sample.landmarks) }));
  const result = analyzeLandmarkTrace(trace);
  return [...new Set(result.detectorCues.map((cue) => cue.code as CueCode))];
}

const diagnosticSignalSide = (code: CueCode, frame: RichFrame): Side => {
  if (code === "foot_cut") {
    if (frame.leftAnkleV > .18 && frame.rightAnkleV > .18) return "both";
    return frame.leftAnkleV >= frame.rightAnkleV ? "left" : "right";
  }
  if (code === "sloppy_feet" || code === "idle_feet") return frame.leftAnkleV >= frame.rightAnkleV ? "left" : "right";
  if (code === "bent_arms") return frame.leftElbow <= frame.rightElbow ? "left" : "right";
  return "center";
};

export type DetectorExportTraceStages = { raw: CueEvent[]; afterBodyResponse: CueEvent[]; afterPogo: CueEvent[]; afterFlag: CueEvent[]; final: CueEvent[] };

/** Replays an exported diagnostic trace through event formation and every suppression boundary. */
export function analyzeDetectorExportTraceStages(trace: DetectorDiagnosticFrame[]): DetectorExportTraceStages {
  const frames: RichFrame[] = [], firings: Firing[] = [], state = states();
  let prev: RichFrame | null = null;
  for (const diagnostic of trace) {
    const denseLandmarks: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    for (const landmark of diagnostic.landmarks) denseLandmarks[landmark.index] = landmark;
    const extracted = extractFrame(denseLandmarks, diagnostic.time_s, prev);
    const feature = diagnostic.features;
    const frame: RichFrame = {
      ...extracted,
      reliable: diagnostic.reliable,
      leftElbow: feature.left_elbow_deg,
      rightElbow: feature.right_elbow_deg,
      leftAnkleV: feature.left_ankle_speed,
      rightAnkleV: feature.right_ankle_speed,
      leftAnkleFlex: feature.left_ankle_flex_deg ?? extracted.leftAnkleFlex,
      rightAnkleFlex: feature.right_ankle_flex_deg ?? extracted.rightAnkleFlex,
      footFlexRequired: feature.left_ankle_flex_deg !== undefined
        || feature.right_ankle_flex_deg !== undefined
        || diagnostic.landmarks.some((landmark) => landmark.index === 31 || landmark.index === 32),
      leftWristV: feature.left_wrist_speed,
      rightWristV: feature.right_wrist_speed,
      hipV: feature.hip_speed,
      bodyV: feature.body_speed,
      shoulderV: Math.max(0, feature.body_speed * 2 - feature.hip_speed),
    };
    const signals: Partial<Record<CueCode, Signal>> = {};
    for (const [rawCode, confidence] of Object.entries(diagnostic.raw_signal_scores)) {
      const code = rawCode as CueCode;
      if (confidence !== undefined) signals[code] = { confidence, side: diagnosticSignalSide(code, frame), joint: code };
    }
    if (frame.reliable) frames.push(frame);
    process(gateFootCutSignal(signals, frames, frame), frame, state, firings);
    prev = frame;
  }
  const afterBodyResponse = suppressFootCutsWithoutBodyResponse(firings, frames);
  const afterPogo = suppressIntentionalPogoSignals(afterBodyResponse, frames);
  const afterFlag = suppressIntentionalFlagFootCuts(afterPogo, frames);
  const afterBoundary = suppressBoundarySignals(afterFlag, frames);
  const afterDismount = suppressSaggingHipsDuringDismounts(afterBoundary, detectDismountEvents(frames));
  return { raw: atomicCueEvents(firings), afterBodyResponse: atomicCueEvents(afterBodyResponse), afterPogo: atomicCueEvents(afterPogo), afterFlag: atomicCueEvents(afterFlag), final: atomicCueEvents(afterDismount) };
}

export function analyzeDetectorExportTrace(trace: DetectorDiagnosticFrame[]): CueCode[] {
  return analyzeDetectorExportTraceStages(trace).final.map((cue) => cue.code as CueCode);
}

export async function analyzeVideo(
  video: HTMLVideoElement,
  pose: any,
  onProgress: (pct: number, detail: string) => void,
  durationHintSeconds?: number,
  analysisWindow?: { startSeconds: number; endSeconds: number },
): Promise<AnalysisResult> {
  // MediaRecorder WebM clips commonly decode with `duration === Infinity`.
  // Saved labels carry their exact clip window, so use that as the sampling
  // duration rather than silently producing NaN totals and zero iterations.
  const duration = resolveAnalysisDuration(video.duration, durationHintSeconds);
  const start = Math.min(
    Math.max(0, analysisWindow?.startSeconds ?? 0),
    Math.max(0, duration - 0.04),
  );
  const requestedEnd = analysisWindow?.endSeconds ?? duration;
  const end = Math.max(start, Math.min(duration - 0.04, requestedEnd));
  const windowDuration = Math.max(0.04, end - start);
  const step = Math.max(.24, windowDuration / MAX_ANALYSIS_SAMPLES);
  const total = Math.max(1, Math.ceil(windowDuration / step) + 1);
  const trace: LandmarkTraceSample[] = [];
  let resolver: ((value: Landmark[] | null) => void) | null = null;
  pose.onResults((result: any) => {
    resolver?.(result.poseLandmarks ?? null);
    resolver = null;
  });
  const run = () =>
    new Promise<Landmark[] | null>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        resolver = null;
        reject(new Error("Pose analysis timed out."));
      }, POSE_ANALYSIS_TIMEOUT_MS);
      resolver = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      pose.send({ image: video }).catch((error: unknown) => {
        clearTimeout(timer);
        resolver = null;
        reject(error instanceof Error ? error : new Error("Pose analysis failed."));
      });
    });
  for (let index = 0; index < total; index += 1) {
    const time = Math.min(end, start + index * step);
    await seek(video, time);
    const landmarks = await run();
    trace.push({ time, landmarks });
    onProgress(
      Math.round(((index + 1) / total) * 100),
      `Checking movement at ${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`,
    );
  }
  return analyzeLandmarkTrace(trace, total);
}
