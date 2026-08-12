import React from 'react';
import type { IndicatorConfig as IndicatorType } from '../../types';

interface IndicatorConfigProps {
  indicator: IndicatorType;
  onUpdate: (updated: IndicatorType) => void;
  onRemove: () => void;
}

// Basic inline styles for the config row to avoid an extra css module for now
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  background: 'rgba(255, 255, 255, 0.03)',
  padding: '8px 12px',
  borderRadius: '6px',
  border: '1px solid var(--border-color)',
  fontSize: '0.85rem'
};

const labelStyle = {
  fontWeight: 600,
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px'
};

const inputStyle = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  width: '54px',
  borderRadius: '4px',
  padding: '2px 4px',
  textAlign: 'center' as const
};

const btnStyle = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

export const IndicatorConfig: React.FC<IndicatorConfigProps> = ({ indicator, onUpdate, onRemove }) => {
  const isPeriodBased = indicator.type === 'SMA' || indicator.type === 'EMA' || indicator.type === 'BOLLINGER' || indicator.type === 'RSI';

  const handlePeriodChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val) && val > 0) {
      onUpdate({ ...indicator, params: { ...indicator.params, period: val } });
    }
  };

  const handleToggle = () => {
    onUpdate({ ...indicator, enabled: !indicator.enabled });
  };

  return (
    <div style={rowStyle}>
      <div style={labelStyle}>
        <div 
          style={{ width: '10px', height: '10px', borderRadius: '50%', background: indicator.color || 'var(--accent-main)' }} 
        />
        {indicator.type}
        
        {isPeriodBased && (
          <input 
            style={inputStyle}
            type="number" 
            value={indicator.params.period as number || 14} 
            onChange={handlePeriodChange}
            min={1}
            max={200}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button style={btnStyle} onClick={handleToggle} title="Toggle Visibility">
          {indicator.enabled ? '👁️' : '👁️‍🗨️'}
        </button>
        <button style={{...btnStyle, color: 'var(--down-color)'}} onClick={onRemove} title="Remove">
          ×
        </button>
      </div>
    </div>
  );
};
