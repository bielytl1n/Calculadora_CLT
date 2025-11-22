import React, { useState, useMemo, useEffect } from 'react';
import { Calculator, DollarSign, Calendar, Info, Moon, Sun, X, Table as TableIcon, Printer, AlertCircle } from 'lucide-react';

// ==========================================
// 1. DOMAIN LAYER (Business Logic, Dates & Types)
// ==========================================

interface TaxTier {
  limit: number;
  rate: number;
  deduction: number;
}

interface PayrollInputs {
  referenceMonth: string; // YYYY-MM
  autoDsr: boolean;
  baseSalary: number;
  divisor: number;
  restDays: number; // DSR (Sundays + Holidays)
  workingDays: number; // Business Days (Total Days - DSR)
  dependents: number;
  qtdNightShift: number;
  qtdHe50: number;
  qtdHe70Night: number;
  qtdHoliday: number;
  valAdvance: number;
  valHealthPlan: number;
  valDental: number;
  valMeal: number;
  valOthers: number;
}

interface PayrollRow {
  code: string;
  desc: string;
  ref: string;
  earning: number;
  discount: number;
  type: 'P' | 'D';
  meta?: string; // For effective rate or extra info
}

interface PayrollResult {
  rows: PayrollRow[];
  totalProventos: number;
  totalDescontos: number;
  liquido: number;
  fgts: number;
  bases: {
    inss: number;
    irrf: number;
    fgts: number;
  };
}

// --- Constants (2025 Configuration) ---
const INSS_TABLE_2025: TaxTier[] = [
  { limit: 1518.00, rate: 0.075, deduction: 0.00 },
  { limit: 2793.88, rate: 0.09, deduction: 22.77 },
  { limit: 4190.83, rate: 0.12, deduction: 106.59 },
  { limit: 8157.41, rate: 0.14, deduction: 190.40 },
];

const IRRF_TABLE_2025: TaxTier[] = [
  { limit: 2428.80, rate: 0.00, deduction: 0.00 },
  { limit: 2826.65, rate: 0.075, deduction: 182.16 },
  { limit: 3751.05, rate: 0.15, deduction: 394.16 },
  { limit: 4664.68, rate: 0.225, deduction: 675.49 },
  { limit: Infinity, rate: 0.275, deduction: 908.73 },
];

const CONSTANTS = {
  DEDUCTION_PER_DEPENDENT: 189.59,
  FGTS_RATE: 0.08,
  STANDARD_DIVISOR: 220,
};

const FIXED_HOLIDAYS = [
  '01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'
];

// --- Pure Functions ---

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
};

const formatNumber = (value: number) => {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
};

const getMonthDetails = (yearMonth: string) => {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr);
  const monthIndex = parseInt(monthStr) - 1; // JS Month is 0-indexed

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  let sundays = 0;
  let holidays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, monthIndex, day);
    const dayOfWeek = date.getDay(); // 0 = Sunday
    const dateString = `${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    if (dayOfWeek === 0) {
      sundays++;
    } else if (FIXED_HOLIDAYS.includes(dateString)) {
      // Only count holiday if it's NOT Sunday (to avoid double counting DSR)
      holidays++;
    }
  }

  const totalRestDays = sundays + holidays;
  const workingDays = daysInMonth - totalRestDays;

  return { daysInMonth, totalRestDays, workingDays };
};

const calculateINSS = (base: number): { value: number; nominalRate: number; effectiveRate: number } => {
  const maxBase = INSS_TABLE_2025[INSS_TABLE_2025.length - 1].limit;
  const effectiveBase = Math.min(base, maxBase);
  const tier = INSS_TABLE_2025.find(t => effectiveBase <= t.limit);
  
  let value = 0;
  if (tier) {
    value = (effectiveBase * tier.rate) - tier.deduction;
  }

  // Determine nominal rate for display
  let nominalRate = 0;
  if (effectiveBase > 0) {
      if (effectiveBase <= 1518.00) nominalRate = 7.5;
      else if (effectiveBase <= 2793.88) nominalRate = 9.0;
      else if (effectiveBase <= 4190.83) nominalRate = 12.0;
      else nominalRate = 14.0;
  }

  const effectiveRate = base > 0 ? (value / base) * 100 : 0;

  return { value, nominalRate, effectiveRate };
};

const calculateIRRF = (base: number, dependents: number): { value: number; nominalRate: number; effectiveRate: number } => {
  const deductionDependents = dependents * CONSTANTS.DEDUCTION_PER_DEPENDENT;
  const taxableBase = base - deductionDependents;
  
  if (taxableBase <= 0) return { value: 0, nominalRate: 0, effectiveRate: 0 };

  const tier = IRRF_TABLE_2025.find(t => taxableBase <= t.limit);
  
  let value = 0;
  let nominalRate = 0;

  if (tier && tier.rate > 0) {
    value = (taxableBase * tier.rate) - tier.deduction;
    nominalRate = tier.rate * 100;
  }

  const effectiveRate = base > 0 ? (value / base) * 100 : 0;

  return { value: Math.max(0, value), nominalRate, effectiveRate };
};

// ==========================================
// 2. APPLICATION LAYER (Custom Hooks)
// ==========================================

const usePayrollCalculator = (inputs: PayrollInputs): PayrollResult => {
  return useMemo(() => {
    const {
      baseSalary, divisor, restDays, workingDays, dependents,
      qtdNightShift, qtdHe50, qtdHe70Night, qtdHoliday,
      valAdvance, valHealthPlan, valDental, valMeal, valOthers
    } = inputs;

    // --- Setup & Safety Checks ---
    const safeDivisor = divisor > 0 ? divisor : CONSTANTS.STANDARD_DIVISOR;
    const hourlyRate = baseSalary / safeDivisor;
    
    // Use workingDays provided by input (which might be auto-calculated or manual)
    // Ensure strictly positive divisor for DSR calculation to avoid Infinity
    const dsrDivisor = workingDays > 0 ? workingDays : 1; 
    
    const rows: PayrollRow[] = [];

    // --- Earnings (Proventos) ---
    rows.push({ code: '0001', desc: 'SALÁRIO MENSALISTA', ref: '30d', earning: baseSalary, discount: 0, type: 'P' });

    const addEarning = (code: string, desc: string, qtd: number, multiplier: number, isHours = true) => {
      if (qtd > 0) {
        const value = hourlyRate * multiplier * qtd;
        rows.push({ 
          code, 
          desc, 
          ref: isHours ? `${formatNumber(qtd)}h` : '-', 
          earning: value, 
          discount: 0, 
          type: 'P' 
        });
        return value;
      }
      return 0;
    };

    const valNightShift = addEarning('0526', 'ADICIONAL NOTURNO 20%', qtdNightShift, 0.20);
    const valHe50 = addEarning('0650', 'HORAS EXTRAS 50%', qtdHe50, 1.50);
    const valHe70Night = addEarning('0660', 'H.E. NOTURNA 70%', qtdHe70Night, 2.04);
    const valHoliday = addEarning('0670', 'DOM/FERIADO TRABALHADO', qtdHoliday, 2.00);

    // --- DSR Calculations (Dynamic) ---
    // Formula: (Variable Earnings / Business Days) * Rest Days
    const calculateDSR = (totalVariableValue: number, description: string, code: string) => {
      if (totalVariableValue > 0 && restDays > 0) {
        const dsrValue = (totalVariableValue / dsrDivisor) * restDays;
        rows.push({
          code,
          desc: description,
          ref: `${restDays}/${dsrDivisor}`, // Shows relation Rest / Working
          earning: dsrValue,
          discount: 0,
          type: 'P'
        });
        return dsrValue;
      }
      return 0;
    };

    calculateDSR(valHe50 + valHe70Night, 'DSR SOBRE HORAS EXTRAS', '0692');
    calculateDSR(valNightShift, 'DSR SOBRE ADIC. NOTURNO', '0694');
    // Note: Holiday work usually includes DSR in its 100% rate or is treated differently depending on convention,
    // strictly speaking DSR usually applies to variable hours. We'll skip DSR on Holiday pay for standard CLT unless specified.

    const totalProventos = rows.reduce((acc, row) => acc + row.earning, 0);

    // --- Discounts (Legal) ---
    
    // INSS
    const { value: inssValue, nominalRate: inssRef, effectiveRate: inssEff } = calculateINSS(totalProventos);
    rows.push({ 
      code: '0003', 
      desc: 'INSS SOBRE SALÁRIO', 
      ref: `${formatNumber(inssRef)}%`, 
      earning: 0, 
      discount: inssValue, 
      type: 'D',
      meta: inssEff > 0 ? `Efetiva: ${formatNumber(inssEff)}%` : undefined
    });

    // IRRF
    const irrfBase = totalProventos - inssValue;
    const { value: irrfValue, nominalRate: irrfRef, effectiveRate: irrfEff } = calculateIRRF(irrfBase, dependents);
    
    if (irrfValue > 0) {
      rows.push({ 
        code: '0004', 
        desc: 'IRRF SOBRE SALÁRIO', 
        ref: `${formatNumber(irrfRef)}%`, 
        earning: 0, 
        discount: irrfValue, 
        type: 'D',
        meta: `Efetiva: ${formatNumber(irrfEff)}%`
      });
    }

    // --- Discounts (Manual) ---
    const addDiscount = (code: string, desc: string, value: number) => {
      if (value > 0) {
        rows.push({ code, desc, ref: '-', earning: 0, discount: value, type: 'D' });
      }
    };

    addDiscount('0019', 'ADIANTAMENTO SALARIAL', valAdvance);
    addDiscount('0600', 'PLANO DE SAÚDE', valHealthPlan);
    addDiscount('0218', 'PLANO ODONTOLÓGICO', valDental);
    addDiscount('1096', 'VALE REFEIÇÃO/ALIM.', valMeal);
    addDiscount('1216', 'OUTROS DESCONTOS', valOthers);

    const totalDescontos = rows.reduce((acc, row) => acc + row.discount, 0);

    return {
      rows,
      totalProventos,
      totalDescontos,
      liquido: totalProventos - totalDescontos,
      // FGTS is calculated on Total Earnings (Bruto), Adiantamento does not reduce it.
      fgts: totalProventos * CONSTANTS.FGTS_RATE,
      bases: {
        inss: Math.min(totalProventos, INSS_TABLE_2025[INSS_TABLE_2025.length - 1].limit),
        irrf: Math.max(0, irrfBase),
        fgts: totalProventos
      }
    };
  }, [inputs]);
};

// ==========================================
// 3. PRESENTATION LAYER (Components)
// ==========================================

const ReferenceModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm print:hidden">
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-gray-200 dark:border-gray-700">
      <div className="flex justify-between items-center p-5 border-b border-gray-100 dark:border-gray-700 sticky top-0 bg-white/95 dark:bg-gray-800/95 backdrop-blur z-10">
        <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <TableIcon className="w-5 h-5 text-blue-600" /> Tabelas de Referência (2025)
        </h3>
        <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors">
          <X className="w-5 h-5 text-gray-500" />
        </button>
      </div>
      
      <div className="p-6 space-y-8">
        {/* INSS Table */}
        <div>
            <h4 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">INSS (Contribuição Previdenciária)</h4>
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                    <th className="p-3">Faixa Salarial</th>
                    <th className="p-3">Alíquota</th>
                    <th className="p-3 text-right">Dedução</th>
                </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-800">
                {INSS_TABLE_2025.map((t, i) => (
                    <tr key={i}>
                    <td className="p-3 text-gray-700 dark:text-gray-300">
                        Até {formatCurrency(t.limit)}
                    </td>
                    <td className="p-3 text-gray-700 dark:text-gray-300">{(t.rate * 100).toFixed(1).replace('.',',')}%</td>
                    <td className="p-3 text-right text-gray-500 dark:text-gray-400 font-mono">
                        {t.deduction > 0 ? formatNumber(t.deduction) : '-'}
                    </td>
                    </tr>
                ))}
                </tbody>
            </table>
            </div>
        </div>

        {/* IRRF Table */}
        <div>
            <h4 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">IRRF (Imposto de Renda)</h4>
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                    <th className="p-3">Base de Cálculo</th>
                    <th className="p-3">Alíquota</th>
                    <th className="p-3 text-right">Dedução</th>
                </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-800">
                {IRRF_TABLE_2025.map((t, i) => (
                    <tr key={i}>
                    <td className="p-3 text-gray-700 dark:text-gray-300">
                        Até {t.limit === Infinity ? '...' : formatCurrency(t.limit)}
                    </td>
                    <td className="p-3 text-gray-700 dark:text-gray-300">
                        {t.rate === 0 ? 'Isento' : `${(t.rate * 100).toFixed(1).replace('.',',')}%`}
                    </td>
                    <td className="p-3 text-right text-gray-500 dark:text-gray-400 font-mono">
                        {t.deduction > 0 ? formatNumber(t.deduction) : '-'}
                    </td>
                    </tr>
                ))}
                </tbody>
            </table>
            </div>
        </div>
      </div>
    </div>
  </div>
);

const Header: React.FC<{ 
  isDarkMode: boolean; 
  toggleTheme: () => void; 
  onShowTables: () => void; 
}> = ({ isDarkMode, toggleTheme, onShowTables }) => (
  <header className="mb-8 flex flex-col md:flex-row justify-between items-center gap-4 print:hidden">
    <div className="flex-1"></div>
    <div className="text-center flex-1">
      <h1 className="text-3xl font-bold text-blue-900 dark:text-blue-400 flex items-center justify-center gap-3">
        <div className="bg-blue-900 dark:bg-blue-700 text-white p-2 rounded-lg shadow-lg">
          <Calculator className="w-6 h-6" />
        </div>
        Calculadora CLT
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mt-2 font-medium">Simulador Fiscal 2025</p>
    </div>
    <div className="flex-1 flex justify-end gap-3 w-full md:w-auto">
      <button 
        onClick={onShowTables}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
      >
        <TableIcon className="w-5 h-5" />
        <span className="hidden sm:inline text-sm font-medium">Tabelas</span>
      </button>
      <button 
        onClick={toggleTheme}
        className="p-2 rounded-full bg-white dark:bg-gray-800 text-orange-500 dark:text-yellow-400 shadow-sm border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
      >
        {isDarkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
      </button>
    </div>
  </header>
);

const InputGroup: React.FC<{
  title: string;
  icon: React.ReactNode;
  colorClass: string;
  children: React.ReactNode;
}> = ({ title, icon, colorClass, children }) => (
  <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 transition-colors print:hidden">
    <h2 className={`text-lg font-semibold mb-4 ${colorClass} border-b border-gray-100 dark:border-gray-700 pb-2 flex items-center gap-2`}>
      {icon} {title}
    </h2>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {children}
    </div>
  </div>
);

const NumberInput: React.FC<{
  label: string;
  name: string;
  value: number | string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  prefix?: string;
  fullWidth?: boolean;
  hint?: string;
  disabled?: boolean;
}> = ({ label, name, value, onChange, type = "number", prefix, fullWidth, hint, disabled }) => (
  <div className={fullWidth ? "col-span-2" : ""}>
    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1" htmlFor={name}>
      {label}
    </label>
    <div className="relative">
      {prefix && <span className="absolute left-3 top-2.5 text-gray-400 text-sm pointer-events-none">{prefix}</span>}
      <input 
        id={name}
        type={type}
        name={name} 
        value={value === 0 ? '' : value} 
        onChange={onChange} 
        disabled={disabled}
        className={`w-full p-2 border ${disabled ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 cursor-not-allowed' : 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white'} border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 outline-none transition-all [color-scheme:light] dark:[color-scheme:dark] ${prefix ? 'pl-8' : ''}`}
        placeholder={type === "number" ? "0" : ""}
      />
    </div>
    {hint && <p className="text-[10px] text-gray-400 mt-1">{hint}</p>}
  </div>
);

// ==========================================
// 4. MAIN COMPONENT (Composition Root)
// ==========================================

const App: React.FC = () => {
  // State
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
       return localStorage.getItem('clt_calc_theme') === 'dark';
    }
    return false;
  });
  const [showTables, setShowTables] = useState(false);
  
  // Initialize with current month
  const initialDate = new Date().toISOString().slice(0, 7); // YYYY-MM
  const initialDetails = getMonthDetails(initialDate);

  const [inputs, setInputs] = useState<PayrollInputs>({
    referenceMonth: initialDate,
    autoDsr: true,
    baseSalary: 0,
    divisor: 220,
    restDays: initialDetails.totalRestDays,
    workingDays: initialDetails.workingDays,
    dependents: 0,
    qtdNightShift: 0,
    qtdHe50: 0,
    qtdHe70Night: 0,
    qtdHoliday: 0,
    valAdvance: 0,
    valHealthPlan: 0,
    valDental: 0,
    valMeal: 0,
    valOthers: 0
  });

  // Effects
  useEffect(() => {
    localStorage.setItem('clt_calc_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // Logic Hook
  const result = usePayrollCalculator(inputs);

  // Handlers
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    
    setInputs(prev => {
      const updated = { ...prev };

      if (name === 'autoDsr') {
        updated.autoDsr = checked;
        // If switching to auto, recalculate immediately based on current month
        if (checked) {
          const details = getMonthDetails(updated.referenceMonth);
          updated.restDays = details.totalRestDays;
          updated.workingDays = details.workingDays;
        }
        return updated;
      }

      if (name === 'referenceMonth') {
        updated.referenceMonth = value;
        if (prev.autoDsr) {
           const details = getMonthDetails(value);
           updated.restDays = details.totalRestDays;
           updated.workingDays = details.workingDays;
        }
        return updated;
      }

      // Handle numeric inputs
      const numericValue = value === '' ? 0 : parseFloat(value);
      
      // @ts-ignore
      updated[name] = numericValue;

      // Special Logic: Base Salary triggers Advance Calculation
      if (name === 'baseSalary') {
        updated.valAdvance = Number((numericValue * 0.40).toFixed(2));
      }

      // Special Logic: Manual DSR Override
      if (name === 'restDays' && !prev.autoDsr) {
          // If manual, we assume standard 30 day commercial basis for inverse? 
          // Or strictly stick to month calendar? Let's stick to calendar size to be consistent.
          const details = getMonthDetails(prev.referenceMonth);
          updated.workingDays = Math.max(1, details.daysInMonth - numericValue); 
      }

      return updated;
    });
  };

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-8 font-sans text-gray-800 dark:text-gray-100 transition-colors duration-300 print:bg-white print:text-black print:p-0">
        
        <Header 
          isDarkMode={isDarkMode} 
          toggleTheme={() => setIsDarkMode(!isDarkMode)} 
          onShowTables={() => setShowTables(true)} 
        />

        {showTables && <ReferenceModal onClose={() => setShowTables(false)} />}

        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 print:block">
          
          {/* INPUTS FORM (Hidden on Print) */}
          <div className="lg:col-span-4 space-y-6 print:hidden">
            
            <InputGroup 
              title="Parâmetros & DSR" 
              icon={<Info className="w-5 h-5" />}
              colorClass="text-blue-900 dark:text-blue-300"
            >
              <NumberInput 
                label="Mês de Referência" 
                name="referenceMonth" 
                type="month"
                value={inputs.referenceMonth} 
                onChange={handleChange} 
                fullWidth
              />
              
              <div className="col-span-2 flex items-center gap-2 mb-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800">
                <input 
                  type="checkbox" 
                  id="autoDsr" 
                  name="autoDsr" 
                  checked={inputs.autoDsr} 
                  onChange={handleChange}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="autoDsr" className="text-xs font-medium text-blue-800 dark:text-blue-300 cursor-pointer select-none">
                  Calcular DSR Automaticamente (Domingos + Feriados)
                </label>
              </div>

              <NumberInput 
                label="Salário Base (R$)" 
                name="baseSalary" 
                value={inputs.baseSalary} 
                onChange={handleChange} 
                prefix="R$" 
                fullWidth 
              />
              
              <NumberInput 
                label="Dias Úteis" 
                name="workingDays" 
                value={inputs.workingDays} 
                onChange={handleChange}
                disabled={true} 
                hint="Calculado: Dias do Mês - DSR"
              />
              <NumberInput 
                label="Descanso (DSR)" 
                name="restDays" 
                value={inputs.restDays} 
                onChange={handleChange} 
                disabled={inputs.autoDsr}
                hint={inputs.autoDsr ? "Automático conforme calendário" : "Manual"} 
              />
              
              <NumberInput label="Divisor (Hs)" name="divisor" value={inputs.divisor} onChange={handleChange} />
              <NumberInput label="Dependentes" name="dependents" value={inputs.dependents} onChange={handleChange} />
            </InputGroup>

            <InputGroup 
              title="Apontamentos (Horas)" 
              icon={<Calendar className="w-5 h-5" />}
              colorClass="text-green-800 dark:text-green-400"
            >
              <NumberInput label="Adic. Noturno (20%)" name="qtdNightShift" value={inputs.qtdNightShift} onChange={handleChange} />
              <NumberInput label="Hora Extra 50%" name="qtdHe50" value={inputs.qtdHe50} onChange={handleChange} />
              <NumberInput label="H.E. Noturna 70%" name="qtdHe70Night" value={inputs.qtdHe70Night} onChange={handleChange} />
              <NumberInput label="Dom/Fer (100%)" name="qtdHoliday" value={inputs.qtdHoliday} onChange={handleChange} />
            </InputGroup>

            <InputGroup 
              title="Outros Descontos (R$)" 
              icon={<DollarSign className="w-5 h-5" />}
              colorClass="text-red-800 dark:text-red-400"
            >
              <NumberInput label="Adiantamento (40%)" name="valAdvance" value={inputs.valAdvance} onChange={handleChange} prefix="R$" />
              <NumberInput label="Plano Saúde" name="valHealthPlan" value={inputs.valHealthPlan} onChange={handleChange} prefix="R$" />
              <NumberInput label="Odontológico" name="valDental" value={inputs.valDental} onChange={handleChange} prefix="R$" />
              <NumberInput label="Vale Refeição" name="valMeal" value={inputs.valMeal} onChange={handleChange} prefix="R$" />
              <NumberInput label="Outros" name="valOthers" value={inputs.valOthers} onChange={handleChange} prefix="R$" fullWidth />
            </InputGroup>

          </div>

          {/* RESULTS DISPLAY */}
          <div className="lg:col-span-8 print:w-full">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl rounded-sm overflow-hidden transition-colors h-full flex flex-col print:shadow-none print:border-2 print:border-gray-900 print:bg-white">
              
              {/* Print Header (Only visible in print) */}
              <div className="hidden print:flex justify-between items-center p-4 border-b-2 border-gray-800 mb-4">
                 <div>
                    <h1 className="text-2xl font-bold text-black">Demonstrativo de Pagamento</h1>
                    <p className="text-sm text-gray-600">Simulação CLT - Base 2025</p>
                 </div>
                 <div className="text-right text-sm text-gray-800">
                    <p>Referência: <strong>{inputs.referenceMonth}</strong></p>
                    <p>Data Emissão: {new Date().toLocaleDateString('pt-BR')}</p>
                 </div>
              </div>

              {/* Table Content */}
              <div className="p-0 overflow-x-auto flex-grow">
                <table className="w-full text-sm min-w-[600px] print:min-w-full">
                  <thead className="bg-gray-100 dark:bg-gray-900/50 print:bg-gray-200 print:text-black">
                    <tr className="border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500 dark:text-gray-400 font-semibold tracking-wider text-left print:text-black print:border-gray-800">
                      <th className="py-3 px-4 w-[10%]">Cód.</th>
                      <th className="py-3 px-4 w-[40%]">Descrição</th>
                      <th className="py-3 px-4 w-[10%] text-center">Ref.</th>
                      <th className="py-3 px-4 w-[20%] text-right text-green-700 dark:text-green-400 print:text-black">Proventos</th>
                      <th className="py-3 px-4 w-[20%] text-right text-red-700 dark:text-red-400 print:text-black">Descontos</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs md:text-sm divide-y divide-gray-100 dark:divide-gray-700/50 print:text-black print:divide-gray-300">
                    {result.rows.length === 0 ? (
                       <tr><td colSpan={5} className="py-8 text-center text-gray-400 italic">Nenhum dado calculado</td></tr>
                    ) : (
                      result.rows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-blue-50 dark:hover:bg-gray-700/50 transition-colors print:hover:bg-transparent">
                          <td className="py-2 px-4 text-gray-400 print:text-gray-600">{row.code}</td>
                          <td className="py-2 px-4 font-medium text-gray-700 dark:text-gray-200 print:text-black">
                            {row.desc}
                            {row.meta && <span className="ml-2 text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded border border-blue-100 dark:border-blue-800 print:border-gray-400 print:text-gray-600 print:bg-transparent">{row.meta}</span>}
                          </td>
                          <td className="py-2 px-4 text-center text-gray-500 dark:text-gray-400 print:text-gray-800">{row.ref}</td>
                          <td className="py-2 px-4 text-right text-green-700 dark:text-green-400 font-medium print:text-black">
                            {row.earning > 0 ? formatNumber(row.earning) : ''}
                          </td>
                          <td className="py-2 px-4 text-right text-red-700 dark:text-red-400 font-medium print:text-black">
                            {row.discount > 0 ? formatNumber(row.discount) : ''}
                          </td>
                        </tr>
                      ))
                    )}
                    {/* Fill empty rows for aesthetics on Screen Only */}
                    {Array.from({ length: Math.max(0, 8 - result.rows.length) }).map((_, i) => (
                       <tr key={`empty-${i}`} className="h-8 print:hidden"><td colSpan={5}></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary Footer */}
              <div className="bg-gray-50 dark:bg-gray-900/30 border-t border-gray-200 dark:border-gray-700 print:bg-white print:border-t-2 print:border-gray-800">
                <div className="grid grid-cols-3 border-b border-gray-200 dark:border-gray-700 divide-x divide-gray-200 dark:divide-gray-700 print:border-gray-800 print:divide-gray-800">
                  <div className="p-3 flex items-center justify-center print:hidden">
                    <button 
                        onClick={() => window.print()}
                        className="flex items-center gap-2 text-gray-500 hover:text-blue-600 transition-colors px-4 py-2 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20" 
                        title="Imprimir Demonstrativo"
                    >
                        <Printer className="w-5 h-5" />
                        <span className="text-xs font-medium">Imprimir</span>
                    </button>
                  </div>
                   {/* Empty Spacer for Print */}
                  <div className="hidden print:block p-3"></div>

                  <div className="p-3 text-right bg-green-50/30 dark:bg-green-900/10 print:bg-transparent">
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider mb-1 print:text-black">Total Proventos</p>
                    <p className="font-mono text-lg text-green-700 dark:text-green-400 font-bold print:text-black">{formatCurrency(result.totalProventos)}</p>
                  </div>
                  <div className="p-3 text-right bg-red-50/30 dark:bg-red-900/10 print:bg-transparent">
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider mb-1 print:text-black">Total Descontos</p>
                    <p className="font-mono text-lg text-red-700 dark:text-red-400 font-bold print:text-black">{formatCurrency(result.totalDescontos)}</p>
                  </div>
                </div>

                {/* Net Pay Highlight */}
                <div className="flex justify-center items-center p-6 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 print:border-gray-800 print:p-4">
                  <div className="bg-blue-50 dark:bg-blue-900/20 px-12 py-6 rounded-lg border border-blue-100 dark:border-blue-800 text-center w-full md:w-2/3 shadow-inner relative overflow-hidden print:bg-gray-100 print:border-gray-400 print:shadow-none">
                    <p className="text-sm text-blue-800 dark:text-blue-300 font-bold uppercase tracking-wide mb-2 print:text-black">Valor Líquido a Receber</p>
                    <p className="text-4xl font-bold text-blue-900 dark:text-blue-100 font-mono print:text-black">{formatCurrency(result.liquido)}</p>
                    
                    {/* Change Indicator Badge */}
                    {result.liquido > 0 && (
                        <div className="absolute top-2 right-2 print:hidden">
                            <AlertCircle className="w-4 h-4 text-blue-400 opacity-50" />
                        </div>
                    )}
                  </div>
                </div>

                {/* Information Strip */}
                <div className="bg-gray-100 dark:bg-gray-900/50 p-4 print:bg-transparent print:p-0 print:mt-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs print:grid-cols-4 print:gap-2">
                    {[
                        { label: 'Salário Base', val: inputs.baseSalary },
                        { label: 'Base INSS', val: result.bases.inss },
                        { label: 'Base FGTS', val: result.bases.fgts },
                        { label: 'FGTS (8%)', val: result.fgts, highlight: true },
                    ].map((item, i) => (
                        <div key={i} className="bg-white dark:bg-gray-700 p-2 rounded border border-gray-200 dark:border-gray-600 print:border-gray-300 print:bg-transparent">
                            <span className="block font-bold text-gray-400 dark:text-gray-400 uppercase text-[10px] print:text-gray-600">{item.label}</span>
                            <span className={`font-mono text-sm ${item.highlight ? 'text-blue-600 dark:text-blue-400 font-bold print:text-black' : 'text-gray-700 dark:text-gray-300 print:text-black'}`}>
                                {formatCurrency(item.val)}
                            </span>
                        </div>
                    ))}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;