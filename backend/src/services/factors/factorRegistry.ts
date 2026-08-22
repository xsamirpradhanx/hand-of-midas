import type { PredictiveFactor } from './types.js';
import { VolumeProfileFactor } from './volumeProfile.js';
import { AtrVolatilityFactor } from './atrVolatility.js';
import { DealerHedgingFactor } from './dealerHedging.js';
import { AnchoredVwapFactor } from './anchoredVwap.js';
import { SessionVwapFactor } from './sessionVwap.js';
import { SwingStructureFactor } from './swingStructure.js';
import { EstimatedCvdFactor } from './estimatedCvd.js';
import { HvlrSupportFactor } from './hvlrSupport.js';
import { OptionsSqueezeFactor } from './squeezeScore.js';
import { RiskReversalSkewFactor } from './riskReversalSkew.js';
import { TermStructureFactor } from './termStructure.js';
import { HurstExponentFactor } from './hurstExponent.js';
import { KamaZScoreFactor } from './kamaZScore.js';
import { InsiderCatalystFactor } from './insiderCatalyst.js';
import { PositioningSentimentFactor } from './positioningSentiment.js';
import { IvRvRatioFactor } from './ivRvRatio.js';
import { MaxPainDriftFactor } from './maxPainDrift.js';
import { VannaDeltaPressureFactor } from './vannaDeltaPressure.js';
import { SmartMoneyFlowFactor } from './smartMoneyFlow.js';
import { RelativeMomentumFactor } from './relativeMomentum.js';

// DO NOT REMOVE THIS LINE. AI QUANT USES IT TO INJECT NEW FACTORS.
import { VolumeInformationEntropyImbalanceFactor } from './ai_factor_1786565158561.js';
import { VolumeSynchronizedEntropyDivergenceFactor } from './ai_factor_1786565842252.js';
import { SpectralMicrostructureInertiaFactor } from './ai_factor_1786565850584.js';
import { FractalEfficiencyLiquiditySweepFactor } from './ai_factor_1786641014202.js';
import { AsymmetricKinematicEfficiencyFactor } from './ai_factor_1787191775255.js';
// [AI_QUANT_IMPORTS_END]

export function getFactors(): PredictiveFactor[] {
  return [
    new VolumeProfileFactor(),
    new AtrVolatilityFactor(),
    new DealerHedgingFactor(),
    new AnchoredVwapFactor(),
    new SessionVwapFactor(),
    new SwingStructureFactor(),
    new EstimatedCvdFactor(),
    new HvlrSupportFactor(),
    new OptionsSqueezeFactor(),
    new RiskReversalSkewFactor(),
    new TermStructureFactor(),
    new HurstExponentFactor(),
    new KamaZScoreFactor(),
    new InsiderCatalystFactor(),
    new PositioningSentimentFactor(),
    new IvRvRatioFactor(),
    new MaxPainDriftFactor(),
    new VannaDeltaPressureFactor(),
    new SmartMoneyFlowFactor(),
    new RelativeMomentumFactor(),
    // DO NOT REMOVE THIS LINE. AI QUANT USES IT TO INJECT NEW FACTORS.
    new VolumeInformationEntropyImbalanceFactor(),
    new VolumeSynchronizedEntropyDivergenceFactor(),
    new SpectralMicrostructureInertiaFactor(),
    new FractalEfficiencyLiquiditySweepFactor(),
    new AsymmetricKinematicEfficiencyFactor(),
    // [AI_QUANT_FACTOR_INSTANCES_END]
  ];
}
