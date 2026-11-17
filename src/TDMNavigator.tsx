import React, { useState, useMemo } from 'react';
import {
  Activity, AlertTriangle, ShieldAlert, CheckCircle2, Stethoscope, User, Zap,
  TrendingUp, Sliders, Printer, Pill, AlertCircle, PlusCircle, Filter,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceArea, ReferenceLine,
} from 'recharts';
import { DRUG_CATEGORIES, INITIAL_DRUG_DATABASE } from './drugData';
import { ssConc, ssPeakTrough } from './pk';

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export default function TDMNavigatorApp() {
  // --- STATE ---
  const [drugDatabase, setDrugDatabase] = useState<Record<string, any>>(INITIAL_DRUG_DATABASE);
  const [selectedDrugKey, setSelectedDrugKey] = useState('vancomycin');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const [patient, setPatient] = useState({
    id: 'PT-89421',
    name: 'Eleanor Vance',
    age: 64,
    gender: 'female',
    weight: 70,
    height: 165,
    scr: 1.3,
    albumin: 3.8,
  });

  const [regimen, setRegimen] = useState({
    dose: 1000,
    interval: 12,
    infusionTime: 1,
    cMeasured: 18.5,
    samplingTime: 11,
  });

  const [selectedSimIndex, setSelectedSimIndex] = useState(1);
  const [customDose, setCustomDose] = useState(1250);
  const [customInterval, setCustomInterval] = useState(12);

  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customDrugForm, setCustomDrugForm] = useState({
    name: 'Investigational NTI Drug X',
    subcategory: 'Novel Therapeutic Agent',
    unit: 'mg',
    concUnit: 'mg/L',
    defaultDose: 100,
    defaultInterval: 12,
    defaultInfusionTime: 1,
    targetTroughMin: 5,
    targetTroughMax: 15,
    targetPeakMin: 20,
    targetPeakMax: 35,
    targetAucMin: 120,
    targetAucMax: 280,
    toxicTrough: 20,
    toxicAuc: 350,
    vdCoeff: 0.6,
    hasNephroRisk: true,
    toxicityTypes: 'Nephrotoxicity, Neurotoxicity, Hepatotoxicity',
  });

  const [showPrintReport, setShowPrintReport] = useState(false);

  const activeDrug = drugDatabase[selectedDrugKey] || drugDatabase.vancomycin;

  const filteredDrugKeys = useMemo(
    () =>
      Object.keys(drugDatabase).filter(
        (key) => selectedCategory === 'all' || drugDatabase[key].category === selectedCategory
      ),
    [drugDatabase, selectedCategory]
  );

  // --- ANTHROPOMETRIC & RENAL CALCULATIONS ---
  const patientCalculations = useMemo(() => {
    const heightInches = patient.height / 2.54;

    let ibw = patient.gender === 'female'
      ? 45.5 + 2.3 * (heightInches - 60)
      : 50 + 2.3 * (heightInches - 60);
    ibw = Math.max(35, r1(ibw));

    const abw = r1(ibw + 0.4 * (patient.weight - ibw));
    const weightForCrCl = patient.weight > 1.2 * ibw ? abw : patient.weight;

    let crCl = ((140 - patient.age) * weightForCrCl) / (72 * Math.max(0.2, patient.scr));
    if (patient.gender === 'female') crCl *= 0.85;
    crCl = r1(crCl);

    const bsa = Math.sqrt((patient.height * patient.weight) / 3600);

    // Winter-Tozer corrected phenytoin level (albumin < 4.4 g/dL)
    let correctedPhenytoin = regimen.cMeasured;
    if (selectedDrugKey === 'phenytoin' && patient.albumin < 4.4 && patient.albumin > 0) {
      correctedPhenytoin = r1(regimen.cMeasured / (0.2 * patient.albumin + 0.1));
    }

    return { ibw, abw, weightForCrCl, crCl, bsa: r2(bsa), correctedPhenytoin };
  }, [patient, regimen.cMeasured, selectedDrugKey]);

  // --- PK ENGINE ---
  const pkResults = useMemo(() => {
    const wt = patient.weight;
    const crCl = patientCalculations.crCl;
    const model = activeDrug.pkModel;

    // 1. Volume of distribution (L)
    let vd = activeDrug.vdCoeff * wt;
    if (model === 'aminoglycoside-extended') {
      vd = activeDrug.vdCoeff * patientCalculations.weightForCrCl;
    } else if (selectedDrugKey === 'digoxin') {
      vd = 3.8 * wt + 3.1 * crCl;
      vd = Math.max(200, Math.min(800, vd));
    } else if (selectedDrugKey === 'lithium') {
      vd = 0.8 * patientCalculations.ibw;
    }

    // 2. Clearance (L/h) and elimination rate constant (1/h)
    let ke = 0;
    let cl = 0;

    if (selectedDrugKey === 'vancomycin') {
      cl = 0.06 * crCl + 0.005 * wt;
      ke = cl / vd;
    } else if (model === 'aminoglycoside-extended') {
      ke = 0.00293 * crCl + 0.014;
      cl = ke * vd;
    } else if (selectedDrugKey === 'digoxin') {
      cl = (0.8 * crCl + 12) * 0.06; // mL/min -> L/h
      ke = cl / vd;
    } else if (selectedDrugKey === 'lithium') {
      cl = (0.2 * crCl + 5) * 0.06; // mL/min -> L/h
      ke = cl / vd;
    } else if (model === 'michaelis-menten') {
      const vmax = 7.0 * wt; // mg/day
      const km = 4.0; // mg/L
      const dailyDose = (regimen.dose / Math.max(0.5, regimen.interval)) * 24;
      const css = (km * dailyDose) / Math.max(1, vmax - dailyDose);
      cl = dailyDose / (Math.max(css, 1e-6) * 24);
      ke = cl / vd;
    } else {
      // Generic placeholder model scaled to renal function
      cl = (crCl / 100) * (vd * 0.04) + 0.15;
      ke = cl / vd;
    }

    // 3. Fit ke to the measured level
    const effectiveMeasured =
      selectedDrugKey === 'phenytoin' && patientCalculations.correctedPhenytoin > 0
        ? patientCalculations.correctedPhenytoin
        : regimen.cMeasured;

    const f = activeDrug.concFactor ?? 1;
    const tInf = Math.max(0.1, regimen.infusionTime || 0.1);
    const D = regimen.dose;
    const tau = Math.max(tInf, regimen.interval || 12);
    const tSamp = ((regimen.samplingTime % tau) + tau) % tau;

    let adjustedKe = ke;
    if (effectiveMeasured > 0 && regimen.samplingTime > 0) {
      const g = (k: number) => ssConc(D, k, vd, tInf, tau, tSamp, f);
      let lo = 0.001;
      let hi = 0.8;
      if (g(lo) >= effectiveMeasured && g(hi) <= effectiveMeasured) {
        for (let i = 0; i < 50; i++) {
          const mid = (lo + hi) / 2;
          if (g(mid) > effectiveMeasured) lo = mid;
          else hi = mid;
        }
        adjustedKe = (lo + hi) / 2;
      }
    }

    const tHalf = Math.log(2) / adjustedKe;
    const finalCl = adjustedKe * vd;
    const { peak: ssPeak, trough: ssTrough } = ssPeakTrough(D, adjustedKe, vd, tInf, tau, f);
    const auc24 = ((f * D) / finalCl) * (24 / tau);

    return {
      vd: r1(vd),
      cl: r2(finalCl),
      ke: Math.round(adjustedKe * 10000) / 10000,
      tHalf: r1(tHalf),
      auc24: r1(auc24),
      ssPeak: r2(ssPeak),
      ssTrough: r2(ssTrough),
    };
  }, [patient, patientCalculations, activeDrug, regimen, selectedDrugKey]);

  // --- DOSE ADJUSTMENT SIMULATOR ---
  const simulatedRegimens = useMemo(() => {
    const { ke, vd, cl } = pkResults;
    const f = activeDrug.concFactor ?? 1;
    const tInf = Math.max(0.1, regimen.infusionTime || 0.1);

    const calculateForOption = (dose: number, interval: number) => {
      const tau = Math.max(tInf, interval || 12);
      const { peak, trough } = ssPeakTrough(dose, ke, vd, tInf, tau, f);
      const auc24 = ((f * dose) / cl) * (24 / tau);

      let status = 'Therapeutic';
      let statusClass = 'text-emerald-400 bg-emerald-950/60 border-emerald-700/60';

      if (trough < activeDrug.targetTroughMin || auc24 < activeDrug.targetAucMin) {
        status = 'Subtherapeutic';
        statusClass = 'text-amber-400 bg-amber-950/60 border-amber-700/60';
      } else if (auc24 > activeDrug.toxicAuc || trough > activeDrug.toxicTrough) {
        status = 'High Toxicity Risk';
        statusClass = 'text-rose-400 bg-rose-950/60 border-rose-700/60';
      } else if (trough > activeDrug.targetTroughMax || auc24 > activeDrug.targetAucMax) {
        status = 'Above Target Range';
        statusClass = 'text-orange-400 bg-orange-950/60 border-orange-700/60';
      }

      return {
        dose,
        interval,
        trough: r2(trough),
        peak: r2(peak),
        auc24: r1(auc24),
        status,
        statusClass,
      };
    };

    const opt1Dose = Math.max(0.01, Math.round(regimen.dose * 0.8 * 1000) / 1000); // 20% reduction

    return [
      { id: 0, label: 'Option A (De-escalated)', ...calculateForOption(opt1Dose, regimen.interval) },
      { id: 1, label: 'Option B (Current)', ...calculateForOption(regimen.dose, regimen.interval) },
      { id: 2, label: 'Option C (Simulated Target)', ...calculateForOption(customDose, customInterval) },
    ];
  }, [regimen, pkResults, activeDrug, customDose, customInterval]);

  // --- CONCENTRATION-TIME GRAPH ---
  const chartData = useMemo(() => {
    const { ke, vd } = pkResults;
    const f = activeDrug.concFactor ?? 1;
    const tInf = Math.max(0.1, regimen.infusionTime || 0.1);
    const tauCur = Math.max(tInf, regimen.interval || 12);
    const activeSim = simulatedRegimens[selectedSimIndex] || simulatedRegimens[1];
    const tauSim = Math.max(tInf, activeSim.interval || 12);
    const maxHours = Math.max(48, tauCur * 2);
    const sampleT = Math.round((((regimen.samplingTime % tauCur) + tauCur) % tauCur) * 2) / 2;
    const measured =
      selectedDrugKey === 'phenytoin' && patientCalculations.correctedPhenytoin > 0
        ? patientCalculations.correctedPhenytoin
        : regimen.cMeasured;

    const data: any[] = [];
    for (let t = 0; t <= maxHours; t += 0.5) {
      const point: any = {
        time: t,
        cCurrent: r2(ssConc(regimen.dose, ke, vd, tInf, tauCur, t, f)),
        cSimulated: r2(ssConc(activeSim.dose, ke, vd, tInf, tauSim, t, f)),
      };
      // Show the measured level once per cycle, at its position in the interval
      if (regimen.cMeasured > 0 && Math.abs((t % tauCur) - sampleT) < 0.01) {
        point.cMeasured = measured;
      }
      data.push(point);
    }
    return data;
  }, [regimen, pkResults, simulatedRegimens, selectedSimIndex, selectedDrugKey, patientCalculations, activeDrug]);

  // --- TOXICITY RISK ANALYSIS ---
  const riskAnalysis = useMemo(() => {
    const auc = pkResults.auc24;
    const trough = pkResults.ssTrough;
    const scr = patient.scr;
    const toxList: string[] = activeDrug.toxicityTypes || [];

    let level = 'LOW';
    let title = 'Low Toxicity Risk — Target Achieved';
    const points: string[] = [];

    if (auc > activeDrug.toxicAuc || trough > activeDrug.toxicTrough || (activeDrug.hasNephroRisk && scr >= 2.0)) {
      level = 'HIGH';
      title = 'HIGH TOXICITY & CLINICAL RISK WARNING';
      if (trough > activeDrug.toxicTrough) {
        points.push(`Predicted trough concentration (${trough} ${activeDrug.concUnit}) exceeds toxic threshold (${activeDrug.toxicTrough} ${activeDrug.concUnit}).`);
      }
      if (auc > activeDrug.toxicAuc) {
        points.push(`24-hour AUC exposure (${auc} ${activeDrug.concUnit}·h) exceeds upper safety threshold (${activeDrug.toxicAuc}).`);
      }
      if (activeDrug.hasNephroRisk && scr >= 2.0) {
        points.push(`Severe renal dysfunction (SCr ${scr} mg/dL, CrCl ${patientCalculations.crCl} mL/min) markedly reduces drug clearance.`);
      }
      points.push(`Associated organ toxicities: ${toxList.join(', ')}.`);
      points.push('Consider holding the dose or decreasing the total daily dose; re-check the level in 24h. Verify against institutional protocol.');
    } else if (trough > activeDrug.targetTroughMax || auc > activeDrug.targetAucMax) {
      level = 'MODERATE';
      title = 'Moderate Accumulation Risk — Above Target';
      points.push(`Predicted level (${trough} ${activeDrug.concUnit}) exceeds upper therapeutic range (${activeDrug.targetTroughMax} ${activeDrug.concUnit}).`);
      points.push(`Potential adverse effects to monitor: ${toxList.slice(0, 2).join(', ')}.`);
      points.push('Consider a minor dose reduction or interval extension.');
    } else if (trough < activeDrug.targetTroughMin || auc < activeDrug.targetAucMin) {
      level = 'SUBTHERAPEUTIC';
      title = 'Subtherapeutic Risk — Efficacy Failure Warning';
      points.push(`Predicted exposure (Trough: ${trough} ${activeDrug.concUnit}) is below minimum target (${activeDrug.targetTroughMin} ${activeDrug.concUnit}).`);
      points.push('Risk of treatment failure or emergence of therapeutic resistance.');
      points.push('Consider dose escalation or interval shortening.');
    } else {
      points.push(`Current steady-state exposure (Trough: ${trough} ${activeDrug.concUnit}, AUC24: ${auc}) is within target bounds.`);
      points.push(`Organ risk factors (${toxList.slice(0, 2).join(', ')}) should continue to be monitored.`);
    }

    return { level, title, points };
  }, [pkResults, patient, activeDrug, patientCalculations]);

  // --- CUSTOM DRUG HANDLER ---
  const handleCreateCustomDrug = (e: React.FormEvent) => {
    e.preventDefault();
    const customKey = `custom_${Date.now()}`;
    const newDrug = {
      name: customDrugForm.name,
      category: 'custom',
      subcategory: customDrugForm.subcategory,
      defaultDose: Number(customDrugForm.defaultDose),
      defaultInterval: Number(customDrugForm.defaultInterval),
      defaultInfusionTime: Number(customDrugForm.defaultInfusionTime),
      unit: customDrugForm.unit,
      concUnit: customDrugForm.concUnit,
      targetTroughMin: Number(customDrugForm.targetTroughMin),
      targetTroughMax: Number(customDrugForm.targetTroughMax),
      targetPeakMin: Number(customDrugForm.targetPeakMin),
      targetPeakMax: Number(customDrugForm.targetPeakMax),
      targetAucMin: Number(customDrugForm.targetAucMin),
      targetAucMax: Number(customDrugForm.targetAucMax),
      toxicTrough: Number(customDrugForm.toxicTrough),
      toxicAuc: Number(customDrugForm.toxicAuc),
      pkModel: 'linear-first-order',
      vdCoeff: Number(customDrugForm.vdCoeff),
      hasNephroRisk: customDrugForm.hasNephroRisk,
      toxicityTypes: customDrugForm.toxicityTypes.split(',').map((s) => s.trim()).filter(Boolean),
      guideline: 'User-Defined Custom NTI Drug Profile',
    };

    setDrugDatabase((prev) => ({ ...prev, [customKey]: newDrug }));
    setSelectedDrugKey(customKey);
    setRegimen({
      dose: newDrug.defaultDose,
      interval: newDrug.defaultInterval,
      infusionTime: newDrug.defaultInfusionTime,
      cMeasured: 0,
      samplingTime: Math.max(0.5, newDrug.defaultInterval - 1),
    });
    setCustomDose(newDrug.defaultDose);
    setCustomInterval(newDrug.defaultInterval);
    setShowCustomModal(false);
  };

  const cf = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCustomDrugForm({ ...customDrugForm, [field]: e.target.value });

  const inputBase =
    'w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 focus:border-teal-500 focus:outline-none';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased selection:bg-teal-500 selection:text-white">
      {/* HEADER */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-gradient-to-tr from-teal-500 to-cyan-500 p-2.5 rounded-xl shadow-lg shadow-teal-500/20">
            <Stethoscope className="w-6 h-6 text-slate-950" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              TDM Navigator
              <span className="text-teal-400 font-normal text-xs ml-1 px-1.5 py-0.5 rounded bg-teal-950 border border-teal-800">
                NTI Platform v3.0
              </span>
            </h1>
            <p className="text-xs text-slate-400 hidden sm:block">
              Comprehensive Multi-Drug Narrow Therapeutic Index CDST
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCustomModal(true)}
            className="hidden sm:flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-teal-300 text-xs font-semibold px-3 py-2 rounded-xl transition"
          >
            <PlusCircle className="w-4 h-4 text-teal-400" />
            <span>Add Custom NTI</span>
          </button>

          <button
            onClick={() => setShowPrintReport(!showPrintReport)}
            className="flex items-center space-x-2 bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold px-3.5 py-2 rounded-xl transition shadow-md shadow-teal-900/30"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">{showPrintReport ? 'Interactive View' : 'Print Report'}</span>
          </button>
        </div>
      </header>

      {/* CUSTOM DRUG MODAL */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center">
                <PlusCircle className="w-5 h-5 text-teal-400 mr-2" />
                Define Custom Narrow Therapeutic Index (NTI) Drug
              </h3>
              <button onClick={() => setShowCustomModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleCreateCustomDrug} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Drug Name</label>
                  <input required type="text" value={customDrugForm.name} onChange={cf('name')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Drug Class / Category</label>
                  <input required type="text" value={customDrugForm.subcategory} onChange={cf('subcategory')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Dose Unit</label>
                  <input type="text" value={customDrugForm.unit} onChange={cf('unit')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Conc. Unit</label>
                  <input type="text" value={customDrugForm.concUnit} onChange={cf('concUnit')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Default Dose</label>
                  <input type="number" step="any" value={customDrugForm.defaultDose} onChange={cf('defaultDose')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Default Interval (h)</label>
                  <input type="number" value={customDrugForm.defaultInterval} onChange={cf('defaultInterval')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3 bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div>
                  <label className="text-slate-400 block mb-1">Min Trough</label>
                  <input type="number" step="0.1" value={customDrugForm.targetTroughMin} onChange={cf('targetTroughMin')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-teal-300" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Max Trough</label>
                  <input type="number" step="0.1" value={customDrugForm.targetTroughMax} onChange={cf('targetTroughMax')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-teal-300" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Toxic Trough</label>
                  <input type="number" step="0.1" value={customDrugForm.toxicTrough} onChange={cf('toxicTrough')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-rose-300" />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Vd Coeff (L/kg)</label>
                  <input type="number" step="0.05" value={customDrugForm.vdCoeff} onChange={cf('vdCoeff')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-cyan-300" />
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Organ Toxicity Profile (Comma-separated)</label>
                <input type="text" value={customDrugForm.toxicityTypes} onChange={cf('toxicityTypes')} className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100" placeholder="e.g. Nephrotoxicity, Neurotoxicity, Hepatotoxicity" />
              </div>

              <div className="flex justify-end space-x-3 border-t border-slate-800 pt-3">
                <button type="button" onClick={() => setShowCustomModal(false)} className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-xl">Save &amp; Load Custom Drug</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      {!showPrintReport ? (
        <main className="max-w-7xl mx-auto px-4 lg:px-8 py-6 space-y-6">
          {/* CATEGORY & DRUG SELECTOR */}
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-sm space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <Filter className="w-4 h-4 text-teal-400" />
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Therapeutic Category Filter:</span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <button
                  onClick={() => setSelectedCategory('all')}
                  className={`px-3 py-1 rounded-lg border transition ${selectedCategory === 'all' ? 'bg-teal-500/20 text-teal-300 border-teal-500/50' : 'bg-slate-800 text-slate-400 border-slate-700'}`}
                >
                  All NTI Drugs ({Object.keys(drugDatabase).length})
                </button>
                {Object.entries(DRUG_CATEGORIES).map(([catKey, catName]) => (
                  <button
                    key={catKey}
                    onClick={() => setSelectedCategory(catKey)}
                    className={`px-3 py-1 rounded-lg border transition ${selectedCategory === catKey ? 'bg-teal-500/20 text-teal-300 border-teal-500/50' : 'bg-slate-800 text-slate-400 border-slate-700'}`}
                  >
                    {catName}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {filteredDrugKeys.map((key) => {
                const d = drugDatabase[key];
                const isSelected = selectedDrugKey === key;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setSelectedDrugKey(key);
                      setRegimen((prev) => ({
                        ...prev,
                        dose: d.defaultDose,
                        interval: d.defaultInterval,
                        infusionTime: d.defaultInfusionTime,
                        cMeasured: 0,
                        samplingTime: Math.max(0.5, d.defaultInterval - 1),
                      }));
                      setCustomDose(d.defaultDose);
                      setCustomInterval(d.defaultInterval);
                    }}
                    className={`p-2.5 rounded-xl border text-left transition flex flex-col justify-between ${
                      isSelected
                        ? 'bg-gradient-to-b from-teal-950/80 to-slate-900 border-teal-500/80 shadow-md ring-1 ring-teal-500/50'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-800'
                    }`}
                  >
                    <div>
                      <span className="text-xs font-bold block text-slate-100 truncate">{d.name}</span>
                      <span className="text-[10px] text-slate-400 block truncate">{d.subcategory}</span>
                    </div>
                    <div className="mt-2 text-[10px] text-teal-400 font-mono">
                      Target: {d.targetTroughMin}-{d.targetTroughMax} {d.concUnit}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ACTIVE DRUG BANNER */}
          <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-4 rounded-2xl border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-sm">
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-teal-500/10 border border-teal-500/20 rounded-xl text-teal-400">
                <Pill className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h2 className="text-lg font-bold text-white">{activeDrug.name}</h2>
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-teal-300 font-medium">
                    {activeDrug.subcategory}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{activeDrug.guideline}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-slate-400 text-[11px] mr-1">Monitored Toxicity Risks:</span>
              {activeDrug.toxicityTypes?.map((tox: string, i: number) => (
                <span key={i} className="bg-rose-950/40 border border-rose-800/50 text-rose-300 px-2 py-0.5 rounded-md text-[11px]">
                  {tox}
                </span>
              ))}
            </div>
          </div>

          {/* INPUTS & PK ENGINE */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* PANEL 1 */}
            <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center space-x-2">
                  <User className="w-4 h-4 text-teal-400" />
                  <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">Patient Profile &amp; Dose Inputs</h3>
                </div>
                <span className="text-[11px] bg-slate-800 text-teal-300 px-2 py-0.5 rounded font-mono">{patient.id}</span>
              </div>

              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <div>
                  <label className="text-slate-400 block mb-1">Age (yr)</label>
                  <input type="number" value={patient.age} onChange={(e) => setPatient({ ...patient, age: Number(e.target.value) })} className={inputBase} />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Gender</label>
                  <select value={patient.gender} onChange={(e) => setPatient({ ...patient, gender: e.target.value })} className={inputBase}>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Weight (kg)</label>
                  <input type="number" value={patient.weight} onChange={(e) => setPatient({ ...patient, weight: Number(e.target.value) })} className={inputBase} />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Height (cm)</label>
                  <input type="number" value={patient.height} onChange={(e) => setPatient({ ...patient, height: Number(e.target.value) })} className={inputBase} />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">SCr (mg/dL)</label>
                  <input type="number" step="0.1" value={patient.scr} onChange={(e) => setPatient({ ...patient, scr: Number(e.target.value) })} className={`${inputBase} text-teal-300 font-semibold`} />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Albumin (g/dL)</label>
                  <input type="number" step="0.1" value={patient.albumin} onChange={(e) => setPatient({ ...patient, albumin: Number(e.target.value) })} className={inputBase} />
                </div>
              </div>

              <div className="bg-slate-950 rounded-xl p-3 border border-slate-800 grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <span className="text-slate-400 block text-[10px]">IBW</span>
                  <span className="font-semibold text-slate-200">{patientCalculations.ibw} kg</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">ABW</span>
                  <span className="font-semibold text-slate-200">{patientCalculations.abw} kg</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">CrCl (CG)</span>
                  <span className="font-bold text-teal-400">{patientCalculations.crCl} mL/min</span>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-3">
                <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center">
                  <Activity className="w-3.5 h-3.5 mr-1.5 text-cyan-400" />
                  Active Dosing Regimen &amp; Observed Level
                </h4>

                <div className="grid grid-cols-3 gap-2.5 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1">Dose ({activeDrug.unit})</label>
                    <input type="number" step="any" value={regimen.dose} onChange={(e) => setRegimen({ ...regimen, dose: Number(e.target.value) })} className={`${inputBase} text-teal-300 font-bold`} />
                  </div>
                  <div>
                    <label className="text-slate-400 block mb-1">Interval (h)</label>
                    <input type="number" value={regimen.interval} onChange={(e) => setRegimen({ ...regimen, interval: Number(e.target.value) })} className={`${inputBase} text-slate-100`} />
                  </div>
                  <div>
                    <label className="text-slate-400 block mb-1">Measured Conc ({activeDrug.concUnit})</label>
                    <input type="number" step="any" value={regimen.cMeasured} onChange={(e) => setRegimen({ ...regimen, cMeasured: Number(e.target.value) })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-amber-300 font-bold focus:border-amber-500 focus:outline-none" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs mt-2.5">
                  <div>
                    <label className="text-slate-400 block mb-1">Infusion Time (h)</label>
                    <input type="number" step="0.25" min="0" value={regimen.infusionTime} onChange={(e) => setRegimen({ ...regimen, infusionTime: Number(e.target.value) })} className={`${inputBase} text-slate-100`} />
                  </div>
                  <div>
                    <label className="text-slate-400 block mb-1">Sample Time (h after dose start)</label>
                    <input type="number" step="0.5" min="0" value={regimen.samplingTime} onChange={(e) => setRegimen({ ...regimen, samplingTime: Number(e.target.value) })} className={`${inputBase} text-slate-100`} />
                  </div>
                </div>

                {selectedDrugKey === 'phenytoin' && patientCalculations.correctedPhenytoin !== regimen.cMeasured && (
                  <div className="mt-2 p-2 bg-amber-950/30 border border-amber-800/40 rounded-lg text-[11px] text-amber-300">
                    Winter-Tozer Corrected Phenytoin Level: <strong>{patientCalculations.correctedPhenytoin} mg/L</strong> (for Albumin {patient.albumin} g/dL).
                  </div>
                )}
              </div>
            </div>

            {/* PANEL 2 */}
            <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                  <div className="flex items-center space-x-2">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">Dynamic PK Parameter Engine</h3>
                  </div>
                  <span className="text-[11px] font-mono text-teal-400 bg-teal-950 px-2 py-0.5 rounded border border-teal-800">Model: {activeDrug.pkModel}</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <span className="text-[10px] text-slate-400 block uppercase">Vd (Volume)</span>
                    <span className="text-lg font-bold text-slate-100">{pkResults.vd} <span className="text-xs font-normal text-slate-400">L</span></span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <span className="text-[10px] text-slate-400 block uppercase">Clearance (CL)</span>
                    <span className="text-lg font-bold text-slate-100">{pkResults.cl} <span className="text-xs font-normal text-slate-400">L/h</span></span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <span className="text-[10px] text-slate-400 block uppercase">Elimination Ke</span>
                    <span className="text-lg font-bold text-slate-100">{pkResults.ke} <span className="text-xs font-normal text-slate-400">h⁻¹</span></span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <span className="text-[10px] text-slate-400 block uppercase">Half-Life (t½)</span>
                    <span className="text-lg font-bold text-teal-400">{pkResults.tHalf} <span className="text-xs font-normal text-slate-400">h</span></span>
                  </div>
                </div>

                <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 space-y-3">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Predicted Steady-State Concentrations</h4>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                      <span className="text-[11px] text-slate-400 block">Pred. Trough (Cmin)</span>
                      <span className={`text-base font-bold ${pkResults.ssTrough > activeDrug.toxicTrough ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {pkResults.ssTrough} <span className="text-xs font-normal text-slate-400">{activeDrug.concUnit}</span>
                      </span>
                    </div>
                    <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                      <span className="text-[11px] text-slate-400 block">Pred. Peak (Cmax)</span>
                      <span className="text-base font-bold text-slate-200">
                        {pkResults.ssPeak} <span className="text-xs font-normal text-slate-400">{activeDrug.concUnit}</span>
                      </span>
                    </div>
                    <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                      <span className="text-[11px] text-slate-400 block">24h AUC (AUC24)</span>
                      <span className={`text-base font-bold ${pkResults.auc24 > activeDrug.toxicAuc ? 'text-rose-400' : 'text-cyan-400'}`}>
                        {pkResults.auc24} <span className="text-xs font-normal text-slate-400">{activeDrug.concUnit}·h</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div
                className={`p-4 rounded-xl border flex items-start space-x-3 transition ${
                  riskAnalysis.level === 'HIGH' ? 'bg-rose-950/50 border-rose-700/80 text-rose-200'
                  : riskAnalysis.level === 'MODERATE' ? 'bg-amber-950/50 border-amber-700/80 text-amber-200'
                  : riskAnalysis.level === 'SUBTHERAPEUTIC' ? 'bg-amber-950/40 border-amber-700/60 text-amber-200'
                  : 'bg-emerald-950/50 border-emerald-700/80 text-emerald-200'
                }`}
              >
                {riskAnalysis.level === 'HIGH' && <ShieldAlert className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />}
                {riskAnalysis.level === 'MODERATE' && <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />}
                {riskAnalysis.level === 'SUBTHERAPEUTIC' && <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />}
                {riskAnalysis.level === 'LOW' && <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-1">{riskAnalysis.title}</h4>
                  <ul className="text-xs space-y-0.5 opacity-90">
                    {riskAnalysis.points.map((pt, i) => (
                      <li key={i}>• {pt}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* CONCENTRATION-TIME CURVE */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide flex items-center">
                  <TrendingUp className="w-4 h-4 mr-2 text-teal-400" />
                  Visual Pharmacokinetic Profile &amp; Target Window
                </h3>
                <p className="text-xs text-slate-400">Interactive steady-state simulation for {activeDrug.name}</p>
              </div>

              <div className="flex items-center space-x-4 text-xs">
                <div className="flex items-center space-x-1.5">
                  <div className="w-3 h-0.5 bg-teal-400 rounded"></div>
                  <span className="text-slate-300">Current Regimen</span>
                </div>
                <div className="flex items-center space-x-1.5">
                  <div className="w-3 h-0.5 bg-cyan-400 border border-dashed border-cyan-400"></div>
                  <span className="text-slate-300">Simulated Regimen</span>
                </div>
                {regimen.cMeasured > 0 && (
                  <div className="flex items-center space-x-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400"></div>
                    <span className="text-slate-300">Measured Level</span>
                  </div>
                )}
              </div>
            </div>

            <div className="h-72 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="time" stroke="#64748b" fontSize={11} unit="h" />
                  <YAxis stroke="#64748b" fontSize={11} domain={[0, 'auto']} unit={` ${activeDrug.concUnit}`} />
                  <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', borderRadius: '0.75rem', fontSize: '12px' }} />

                  <ReferenceArea
                    y1={activeDrug.targetTroughMin}
                    y2={activeDrug.targetTroughMax}
                    fill="#10b981"
                    fillOpacity={0.08}
                    strokeOpacity={0}
                    ifOverflow="extendDomain"
                  />

                  {activeDrug.toxicTrough && (
                    <ReferenceLine
                      y={activeDrug.toxicTrough}
                      stroke="#f43f5e"
                      strokeDasharray="4 4"
                      ifOverflow="extendDomain"
                      label={{ value: `Tox Threshold (${activeDrug.toxicTrough})`, fill: '#f43f5e', fontSize: 10, position: 'insideTopRight' }}
                    />
                  )}

                  <Line type="monotone" dataKey="cCurrent" name="Current Regimen" stroke="#2dd4bf" strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="cSimulated" name="Proposed Regimen" stroke="#06b6d4" strokeDasharray="5 5" strokeWidth={2} dot={false} />
                  {regimen.cMeasured > 0 && (
                    <Line type="monotone" dataKey="cMeasured" name="Measured Level" stroke="#f59e0b" strokeWidth={0} dot={{ r: 6, fill: '#f59e0b', stroke: '#fff', strokeWidth: 1.5 }} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* DOSE SIMULATOR */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide flex items-center">
                  <Sliders className="w-4 h-4 mr-2 text-teal-400" />
                  Multi-Regimen Dose Adjustment Simulator
                </h3>
                <p className="text-xs text-slate-400">Side-by-side comparison of alternative dosing schedules</p>
              </div>

              <div className="flex items-center space-x-3 text-xs bg-slate-950 p-2 rounded-xl border border-slate-800">
                <span className="text-slate-400 font-medium">Custom Option C:</span>
                <input type="number" step="any" value={customDose} onChange={(e) => setCustomDose(Number(e.target.value))} className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-teal-300 font-semibold text-center" />
                <span className="text-slate-400">{activeDrug.unit} q</span>
                <input type="number" value={customInterval} onChange={(e) => setCustomInterval(Number(e.target.value))} className="w-14 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-teal-300 font-semibold text-center" />
                <span className="text-slate-400">h</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 bg-slate-950">
                    <th className="p-3">Select</th>
                    <th className="p-3">Regimen Option</th>
                    <th className="p-3">Dose &amp; Interval</th>
                    <th className="p-3">Pred. Trough ({activeDrug.concUnit})</th>
                    <th className="p-3">Pred. Peak ({activeDrug.concUnit})</th>
                    <th className="p-3">24h AUC ({activeDrug.concUnit}·h)</th>
                    <th className="p-3">Therapeutic Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {simulatedRegimens.map((sim) => {
                    const isSelected = selectedSimIndex === sim.id;
                    return (
                      <tr
                        key={sim.id}
                        onClick={() => setSelectedSimIndex(sim.id)}
                        className={`cursor-pointer transition hover:bg-slate-800 ${isSelected ? 'bg-teal-950/30 font-semibold' : ''}`}
                      >
                        <td className="p-3">
                          <input type="radio" name="selectedSim" checked={isSelected} onChange={() => setSelectedSimIndex(sim.id)} className="text-teal-500 focus:ring-teal-500 cursor-pointer" />
                        </td>
                        <td className="p-3 text-slate-200">{sim.label}</td>
                        <td className="p-3 text-teal-300 font-mono">{sim.dose} {activeDrug.unit} q{sim.interval}h</td>
                        <td className="p-3 text-slate-200 font-semibold">{sim.trough}</td>
                        <td className="p-3 text-slate-300">{sim.peak}</td>
                        <td className="p-3 text-cyan-300 font-semibold">{sim.auc24}</td>
                        <td className="p-3">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-[11px] font-medium border ${sim.statusClass}`}>
                            {sim.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] text-slate-500 text-center">
            Decision-support estimate only. Population PK parameters for several agents are generic placeholders —
            verify all outputs against institutional protocols and clinical judgement before acting.
          </p>
        </main>
      ) : (
        /* PRINT REPORT */
        <div className="max-w-5xl mx-auto p-8 bg-white text-slate-900 rounded-2xl shadow-2xl my-6 border border-slate-200">
          <div className="flex justify-between items-start border-b border-slate-200 pb-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Clinical TDM Consultation Report</h1>
              <p className="text-xs text-slate-500">Narrow Therapeutic Index Precision Dosing Assessment</p>
            </div>
            <div className="text-right">
              <span className="text-xs font-mono bg-slate-100 px-2.5 py-1 rounded border border-slate-300">{patient.id}</span>
              <p className="text-xs text-slate-500 mt-1">{new Date().toLocaleDateString()}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 my-4 text-xs">
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <h4 className="font-semibold text-slate-700 border-b pb-1 mb-1">Patient Details</h4>
              <p>Name: {patient.name} | Age: {patient.age} y/o ({patient.gender})</p>
              <p>Weight: {patient.weight} kg | CrCl: {patientCalculations.crCl} mL/min</p>
            </div>
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <h4 className="font-semibold text-slate-700 border-b pb-1 mb-1">Agent &amp; Target</h4>
              <p>Drug: <strong>{activeDrug.name}</strong> ({activeDrug.subcategory})</p>
              <p>Target Trough: {activeDrug.targetTroughMin}-{activeDrug.targetTroughMax} {activeDrug.concUnit}</p>
            </div>
          </div>

          <div className="my-4 p-3 bg-slate-50 rounded-lg border text-xs">
            <h4 className="font-bold text-slate-800 mb-1">Clinical Recommendation Summary</h4>
            <p>Selected Regimen: <strong>{simulatedRegimens[selectedSimIndex].dose} {activeDrug.unit} q{simulatedRegimens[selectedSimIndex].interval}h</strong></p>
            <p>Predicted Exposure: Trough {simulatedRegimens[selectedSimIndex].trough} {activeDrug.concUnit} | AUC24 {simulatedRegimens[selectedSimIndex].auc24}</p>
            <p>Status: {simulatedRegimens[selectedSimIndex].status}</p>
          </div>

          <div className="mt-8 pt-4 border-t border-slate-200 flex justify-between text-xs text-slate-400">
            <span>TDM Navigator CDST Engine</span>
            <span>Clinician Signature: _______________________</span>
          </div>

          <div className="mt-4 text-center">
            <button onClick={() => window.print()} className="bg-slate-900 text-white text-xs px-4 py-2 rounded-lg">Print Report</button>
          </div>
        </div>
      )}

      <footer className="border-t border-slate-800 text-slate-500 text-xs py-4 text-center mt-12">
        <p>TDM Navigator™ NTI Platform — Multi-Drug Precision Decision Support System</p>
      </footer>
    </div>
  );
}
