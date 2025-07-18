'use client'

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import {
 ComposedChart, XAxis, YAxis, Tooltip,
 ResponsiveContainer, Scatter, Line, Area, Brush
} from 'recharts'
import { useChartData } from '@/context/ChartDataContext'

// --- Constants ---
const INITIAL_CANDLE_INTERVAL_MS = 60 * 1000; // Default to 1 minute
const POLLING_INTERVAL_MS = 5 * 1000;       // Fetch price every 5s
const MAX_DISPLAY_POINTS = 150;       // Max candles/points shown in main chart
const MAX_HISTORY_CANDLES = 200;      // Hard cap across intervals
const MAX_RAW_TICKS = Math.max(300, (15 * 60 * 1000) / POLLING_INTERVAL_MS * 3); // Store enough raw ticks for ~45 mins (for 15m re-aggregation)
const INITIAL_BRUSH_POINTS_VISIBLE = MAX_DISPLAY_POINTS;
const USER_WINDOW_HOLD_MS = 30 * 1000; // Time to keep manual brush view
const CENTER_OFFSET = Math.floor(MAX_DISPLAY_POINTS / 2);
const RIGHT_MARGIN_SLOTS = Math.floor(MAX_DISPLAY_POINTS * 0.15);

const computeWindow = (len) => {
    const end = Math.max(0, len - 1);
    const start = Math.max(0, end - MAX_DISPLAY_POINTS + 1);
    return { startIndex: start, endIndex: end };
};

// --- Helper Functions ---
const formatUsd = (value, detail = false) => { 
    if (typeof value !== 'number' || isNaN(value)) return 'N/A';
    if (value === 0) return '$0.00';
    const minFrac = detail ? Math.max(2, Math.min(8, -Math.floor(Math.log10(Math.abs(value))) + 2)) : 2;
    const maxFrac = detail ? Math.max(2, Math.min(8, -Math.floor(Math.log10(Math.abs(value))) + 4)) : 2;
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac });
};
const formatTime = (unixTime) => new Date(unixTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit'}); 
const defaultTickFormatter = (v) => { 
    if (typeof v !== 'number' || isNaN(v)) return '';
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return v.toFixed(0);
};

// --- Custom Tick Component ---
const DexStylePriceTick = React.memo((props) => {
    const { x, y, payload, textAnchor = 'end', fill = '#ddd', fontSize = 10 } = props;
  const { value } = payload;
  if (typeof value !== 'number' || isNaN(value)) return null;
  let formattedTick = '';
  if (value >= 1) {
    formattedTick = value.toFixed(2);
  } else if (value >= 0.01) {
    formattedTick = value.toFixed(4);
  } else {
    formattedTick = value.toExponential(2);
  }
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={fontSize * 0.35} textAnchor={textAnchor} fill={fill} fontSize={fontSize}>
        {formattedTick}
      </text>
    </g>
  );
});
DexStylePriceTick.displayName = 'DexStylePriceTick';

// --- Candlestick Shape Component ---
const CandlestickShape = React.memo((props) => { 
  const { x, payload, yAxis, width: candleSlotWidth } = props; 
  if (typeof x !== 'number' || isNaN(x)) { return null; }
  if (!payload || payload.open == null || payload.high == null || payload.low == null || payload.close == null || !yAxis || typeof yAxis.scale !== 'function' || !candleSlotWidth || candleSlotWidth <= 0 || isNaN(candleSlotWidth)) { return null; }
  const scale = yAxis.scale; const yHigh = typeof payload.high === 'number' ? scale(payload.high) : NaN; const yLow = typeof payload.low === 'number' ? scale(payload.low) : NaN; const yOpen = typeof payload.open === 'number' ? scale(payload.open) : NaN; const yClose = typeof payload.close === 'number' ? scale(payload.close) : NaN;
  if ([yHigh, yLow, yOpen, yClose].some(val => isNaN(val))) { return null; }
  const isGreen = payload.close >= payload.open;
  const color = isGreen ? "#26A69A" : "#EF5350";
  const bodyY = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(1, Math.abs(yOpen - yClose));
  const candleActualWidth = Math.max(1, candleSlotWidth * 0.55);
  const xCoord = x + (candleSlotWidth - candleActualWidth) / 2;
    if (isNaN(xCoord) || isNaN(bodyY) || isNaN(bodyHeight) || isNaN(candleActualWidth) ) { console.warn("CandlestickShape: NaN value detected before rendering SVG shape", { xCoord, bodyY, bodyHeight, candleActualWidth, yHigh, yLow, props }); return null; }
  return ( <g> <line x1={xCoord + candleActualWidth / 2} y1={yHigh} x2={xCoord + candleActualWidth / 2} y2={yLow} stroke={color} strokeWidth={1.5} /> <rect x={xCoord} y={bodyY} width={candleActualWidth} height={bodyHeight} fill={color} /> </g> );
});
CandlestickShape.displayName = 'CandlestickShape';

const CandleTooltip = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    if (!d || d.open == null || d.close == null) return null;
    return (
        <div style={{ backgroundColor: 'rgba(30,30,30,0.9)', border: '1px solid #555', borderRadius: 4, padding: '8px 12px' }}>
            <div style={{ color: '#fff', fontSize: '12px', marginBottom: 4, fontWeight: 'bold' }}>{formatTime(d.timestamp)}</div>
            <div style={{ color: '#eee', fontSize: '11px' }}>O: {d.open.toPrecision(6)}<br/>C: {d.close.toPrecision(6)}</div>
        </div>
    );
}; 

// --- Re-aggregation Function ---
const aggregateHistoricalCandles = (rawTicks, intervalMs, maxCandles) => {
    const now = Math.floor(Date.now() / intervalMs) * intervalMs;
    const slots = Array.from({ length: maxCandles }, (_, i) => now - (maxCandles - 1 - i) * intervalMs);

    const slotMap = new Map();
    if (Array.isArray(rawTicks)) {
        for (const tick of rawTicks) {
            const { timestamp, price } = tick || {};
            if (typeof timestamp !== 'number' || typeof price !== 'number' || isNaN(timestamp) || isNaN(price)) continue;
            const slot = Math.floor(timestamp / intervalMs) * intervalMs;
            if (!slotMap.has(slot)) slotMap.set(slot, []);
            slotMap.get(slot).push(price);
        }
    }

   // Track previous close to derive the next candle's open when data exists
    let prevClose = Array.isArray(rawTicks) && rawTicks.length > 0 ? rawTicks[0].price : null;
    const result = slots.map(slotTime => {
        const prices = slotMap.get(slotTime);
        if (prices && prices.length > 0) {
            const open = prevClose;
            const close = prices[prices.length - 1];
            const high = Math.max(open, ...prices);
            const low = Math.min(open, ...prices);
            prevClose = close;
            return { timestamp: slotTime, open, high, low, close };
        }
        return null;
    });

    return result;
};

// --- Main Chart Component ---
export default function LiveTokenChart({
  tokenMint, tokenDecimals, tokenSupply, connection, selectedPool, network
}) {
    const [hasMounted, setHasMounted] = useState(false);
    const [selectedCandleIntervalMs, setSelectedCandleIntervalMs] = useState(INITIAL_CANDLE_INTERVAL_MS);
    const [chartMode, setChartMode] = useState('price'); 
    const [ohlcData, setOhlcData] = useState([]);
    const [currentCandle, setCurrentCandle] = useState(null);

    useEffect(() => {
        setHasMounted(true);
    }, []);

    const {
        rawPriceHistory,
        marketCapHistory,
        lastPrice,
        currentMarketCap,
        currentLpValue,
        solUsdPrice,
        isLoadingSolPrice,
        errorMsg,
        isInitialLoading,
        startTracking,
        stopTracking,
    } = useChartData();

    const startTrackingRef = useRef(startTracking);
    const stopTrackingRef = useRef(stopTracking);
    const lastConfigRef = useRef({ mint: '', pool: null });
    const lastBrushInteractionRef = useRef(0);
    const prevDataLenRef = useRef(0);

    useEffect(() => { startTrackingRef.current = startTracking; }, [startTracking]);
    useEffect(() => { stopTrackingRef.current = stopTracking; }, [stopTracking]);
    useEffect(() => {
        if (hasMounted) {
            lastBrushInteractionRef.current = Date.now();
        }
    }, [hasMounted]);

    // Rehydrate local chart state from global context on mount so any
    // previously fetched data is displayed immediately when navigating
    // back to the chart.
    useEffect(() => {
        if (rawPriceHistory && rawPriceHistory.length > 0) {
            const maxCandles = Math.min(
                MAX_DISPLAY_POINTS,
                MAX_HISTORY_CANDLES,
                Math.floor((MAX_RAW_TICKS * POLLING_INTERVAL_MS) / selectedCandleIntervalMs)
            );
            const historicalCandles = aggregateHistoricalCandles(
                rawPriceHistory,
                selectedCandleIntervalMs,
                maxCandles
            );
            setOhlcData(historicalCandles);
        }
    }, [rawPriceHistory, selectedCandleIntervalMs]);
  
    const [brushWindow, setBrushWindow] = useState(() => computeWindow(0));

    useEffect(() => {
        if (!hasMounted) return;
        const sameMint = lastConfigRef.current.mint === tokenMint;
        const samePoolId = lastConfigRef.current.pool?.id === selectedPool?.id;

        if (tokenMint && tokenDecimals != null) {
            if (!sameMint || !samePoolId) {
                // Do not reset data unnecessarily when the connection object changes
                lastBrushInteractionRef.current = Date.now();
                lastConfigRef.current = { mint: tokenMint, pool: selectedPool };
                startTrackingRef.current(tokenMint, connection, tokenDecimals, tokenSupply, selectedPool);
            }
        } else {
            setOhlcData([]);
            setCurrentCandle(null);
            prevDataLenRef.current = 0;
            stopTrackingRef.current();
            lastConfigRef.current = { mint: '', pool: null };
        }
    }, [hasMounted, tokenMint, tokenDecimals, tokenSupply, selectedPool]);

    // Do not stop tracking on unmount so data continues accumulating even when
    // the chart component is not visible. Tracking will stop when the token
    // itself is cleared via the dependency effect above.

    useEffect(() => {
        if (!hasMounted) return;
        if (rawPriceHistory.length === 0) return;
        console.log(`LiveTokenChart: Interval changed to ${selectedCandleIntervalMs / 1000}s. Re-aggregating.`);
        const maxCandles = Math.min(
            MAX_DISPLAY_POINTS,
            MAX_HISTORY_CANDLES,
            Math.floor((MAX_RAW_TICKS * POLLING_INTERVAL_MS) / selectedCandleIntervalMs)
        );
        const historicalCandles = aggregateHistoricalCandles(rawPriceHistory, selectedCandleIntervalMs, maxCandles);
        setOhlcData(prev => {
            const isSame =
                prev.length === historicalCandles.length &&
                prev.every((c, i) => {
                    const next = historicalCandles[i];
                    return (
                        c &&
                        next &&
                        c.timestamp === next.timestamp &&
                        c.open === next.open &&
                        c.close === next.close &&
                        c.high === next.high &&
                        c.low === next.low
                    );
                });
            if (isSame) {
                console.log('[LiveTokenChart] Candles unchanged, no update.');
                return prev;
            }
            console.log('[LiveTokenChart] Candles changed, updating.');
            return historicalCandles;
        });
        setCurrentCandle(null);
        
       const newWindow = computeWindow(historicalCandles.length);
        setBrushWindow(prev => {
            const now = Date.now();
            const atLiveEdge = prev.endIndex >= prevDataLenRef.current - 1;
            const keepUserView = !atLiveEdge && (now - lastBrushInteractionRef.current) < USER_WINDOW_HOLD_MS;
            prevDataLenRef.current = historicalCandles.length;
            if (keepUserView) {
                return prev;
            }
            if (prev.startIndex !== newWindow.startIndex || prev.endIndex !== newWindow.endIndex) {
                return newWindow;
            }
            return prev;
        });
    }, [hasMounted, selectedCandleIntervalMs, rawPriceHistory])

    const chartSourceData = useMemo(() => {
        if (chartMode === "price") {
            let data = [...ohlcData];
            if (currentCandle) {
                data.push({ ...currentCandle, close: currentCandle.currentClose });
            }
           data = data.filter(c => c && typeof c.timestamp === "number");
            const startOffset = Math.max(CENTER_OFFSET - data.length + 1, RIGHT_MARGIN_SLOTS);
            return data.map((c, index) => ({ ...c, key: `ohlc-${c.timestamp}-${index}`, index: startOffset + index }));
        }
       const filtered = marketCapHistory.filter(mc => mc && typeof mc.timestamp === "number" && typeof mc.marketCap === "number");
       return filtered.map((mc, index) => ({ ...mc, key: `mc-${mc.timestamp}-${index}`, index }));

        }, [ohlcData, currentCandle, marketCapHistory, chartMode]);

    const yAxisDomain = useMemo(() => { 
        const currentDataLength = chartSourceData.length; 
        const safeStartIndex = Math.max(0, Math.min(brushWindow.startIndex, currentDataLength - 1));
        const safeEndIndex = Math.max(safeStartIndex, Math.min(brushWindow.endIndex, currentDataLength - 1));
        
        const visibleData = chartSourceData.slice(safeStartIndex, safeEndIndex + 1);

        if (!visibleData || visibleData.length === 0) return ['auto', 'auto'];
        
        let minVal = Infinity; let maxVal = 0;
       if (chartMode === 'price') {
            visibleData.forEach(d => {
                if (!d) return;
                if (d.low > 0) minVal = Math.min(minVal, d.low);
                if (d.high > 0) maxVal = Math.max(maxVal, d.high);
            });
        } else {
            visibleData.forEach(d => {
                if (!d) return;
                if (d.marketCap > 0) minVal = Math.min(minVal, d.marketCap);
                if (d.marketCap > 0) maxVal = Math.max(maxVal, d.marketCap);
            });
        }
        
        if (minVal === Infinity || maxVal === 0) { const fallbackLast = chartMode === 'price' ? lastPrice : currentMarketCap; if (fallbackLast > 0) return [fallbackLast * 0.5, fallbackLast * 1.5]; return chartMode === 'price' ? [0.00000001, 0.000001] : [1, 1000]; }
        
        const dataRange = maxVal - minVal; const padding = dataRange > 0 ? dataRange * 0.15 : maxVal * 0.15; 
        let domainMin = Math.max(chartMode === 'price' ? 0.0000000001 : 1, minVal - padding); 
        let domainMax = maxVal + padding;
        
        if (domainMin >= domainMax || !isFinite(domainMin) || !isFinite(domainMax)) { domainMin = minVal * 0.8; domainMax = maxVal * 1.2; if (domainMin <=0 && chartMode === 'price') domainMin = minVal > 0 ? minVal / 2 : 0.0000000001; if (domainMin <=0 && chartMode === 'marketCap') domainMin = minVal > 0 ? minVal / 2 : 1; if (domainMin >= domainMax || !isFinite(domainMin) || !isFinite(domainMax) ) { domainMin = 0.0000000001; domainMax = 1;} }
        return [domainMin, domainMax];
    }, [chartSourceData, chartMode, lastPrice, currentMarketCap, brushWindow]); 

    const handleBrushChange = useCallback(({ startIndex, endIndex }) => {
        if (!hasMounted) return;
        const currentDataLength = chartSourceData.length;
        const maxIndex = Math.max(0, currentDataLength - 1);
        const rawStartIndex = (typeof startIndex === 'number' && !isNaN(startIndex)) ? startIndex : 0;
        const rawEndIndex = (typeof endIndex === 'number' && !isNaN(endIndex)) ? endIndex : maxIndex;
        const finalStartIndex = Math.max(0, Math.min(rawStartIndex, maxIndex));
        const finalEndIndex = Math.min(Math.max(finalStartIndex, rawEndIndex), maxIndex);
        lastBrushInteractionRef.current = Date.now();
        setBrushWindow(prev => {
            if (prev.startIndex !== finalStartIndex || prev.endIndex !== finalEndIndex) {
                return { startIndex: finalStartIndex, endIndex: finalEndIndex };
            }
            return prev;
        });
   }, [hasMounted, chartSourceData.length]);

if (!hasMounted) {
        return <div style={{ width: '100%', height: 420, backgroundColor: '#000' }} />;
    }

    const currentPriceForStats = currentCandle?.currentClose ?? lastPrice ?? 0;
    const displayPriceUsd = solUsdPrice !== null ? currentPriceForStats * solUsdPrice : null;
    const displayMarketCapUsd = solUsdPrice !== null ? currentMarketCap * solUsdPrice : null;
    const displayLpValueUsd = solUsdPrice !== null ? currentLpValue * solUsdPrice : null;

    const renderChartContent = () => { 
        if (isInitialLoading && chartSourceData.length === 0 && !errorMsg) { return <div className="text-gray-400 text-center p-10">Loading initial pool data...</div>; }
        if (errorMsg && chartSourceData.length === 0) { return <div className="text-red-400 text-center p-10">{errorMsg}</div>; }
        if (chartSourceData.length === 0 && !errorMsg) { return <div className="text-gray-400 text-center p-10">No chart data available. Waiting for pool activity...</div>; }

        const currentDataLen = chartSourceData.length;
        const validStartIndex = Math.max(0, Math.min(brushWindow.startIndex, currentDataLen - 1));
        const validEndIndex = Math.max(validStartIndex, Math.min(brushWindow.endIndex, currentDataLen - 1));

        return (
           <ResponsiveContainer key={`${chartMode}-${selectedCandleIntervalMs}`} width="100%" height={420} style={{ backgroundColor: '#000' }}>
               <ComposedChart data={chartSourceData} margin={{ top: 5, right: 5, left: 0, bottom: 60 }}>
                    <XAxis
                        dataKey="index"
                        type="number"
                        domain={[0, MAX_DISPLAY_POINTS - 1]}
                        tickFormatter={(v) => {
                            const idx = Math.round(v);
                            const item = chartSourceData.find((d) => d.index === idx);
                            return item ? formatTime(item.timestamp) : '';
                        }}
                        tick={{ fill: '#888', fontSize: 9, angle: -40 }}
                        axisLine={{ stroke: '#444' }}
                        tickLine={{ stroke: '#444' }}
                        dy={15}
                        dx={-10}
                        ticks={(() => {
                            const ticks = [];
                            const range = validEndIndex - validStartIndex;
                            const desired = 5;
                            const step = Math.max(1, Math.ceil(range / desired));
                            for (let i = validStartIndex; i <= validEndIndex; i += step) {
                                const item = chartSourceData[i];
                                if (item) ticks.push(item.index);
                            }
                            const last = chartSourceData[validEndIndex];
                            if (last && ticks[ticks.length - 1] !== last.index) {
                                ticks.push(last.index);
                            }
                            return ticks;
                        })()}
                        allowDuplicatedCategory={false}
                        minTickGap={30}
                        textAnchor="end"
                        height={45}
                        label={{ value: 'Time', fill: '#aaa', position: 'insideBottom', offset: -50 }}
                    />
                    <YAxis
                        yAxisId="primary"
                        domain={yAxisDomain}
                        axisLine={{ stroke: '#444' }}
                        tickLine={{ stroke: '#444' }}
                        tick={chartMode === 'price' ? <DexStylePriceTick fill="#ddd" /> : { fill: '#888', fontSize: 10 }}
                        tickFormatter={chartMode !== 'price' ? defaultTickFormatter : undefined}
                        orientation="left"
                        scale={chartMode === 'price' ? "log" : "linear"}
                        allowDataOverflow={true}
                        tickCount={6}
                        dx={-2}
                        width={55}
                        label={{ value: chartMode === 'price' ? 'Price (SOL)' : 'Market Cap (SOL)', angle: -90, position: 'insideLeft', fill: '#aaa', dx: -40 }}
                    />
                    
                    <Tooltip content={<CandleTooltip />} cursor={{fill: "rgba(200,200,200,0.1)"}} />
                   
                    {chartMode === 'price' ? ( <Scatter yAxisId="primary" name="OHLC Details" dataKey="close" shape={(p)=>{let w=10;const {viewBox}=p;if(viewBox?.width>0){w=viewBox.width/MAX_DISPLAY_POINTS;}return <CandlestickShape {...p} width={Math.max(2,w)} />;}} isAnimationActive={false} key="priceScatter" /> )
                    : ( <Area yAxisId="primary" type="monotone" dataKey="marketCap" name="Market Cap" stroke="#8884d8" fill="url(#mcGradient)" fillOpacity={0.5} strokeWidth={1.5} connectNulls={true} isAnimationActive={false} dot={false} key="marketCapArea" /> )}
                    <defs> <linearGradient id="mcGradient" x1="0" y1="0" x2="0" y2="1"> <stop offset="5%" stopColor="#8884d8" stopOpacity={0.5}/> <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/> </linearGradient> </defs>
                    
                      {chartSourceData.length > 1 && ( 
                       <Brush 
                          dataKey="index" height={30} stroke="#555"
                          y={380}
                          startIndex={validStartIndex} 
                          endIndex={validEndIndex}
                          tickFormatter={(v)=>{const item=chartSourceData.find(d=>d.index===v);return item?formatTime(item.timestamp):""}} 
                          onChange={handleBrushChange} 
                          travellerWidth={10} 
                          padding={{ top: 5, bottom: 5 }} 
                          fill="rgba(60, 60, 60, 0.5)"
                        >
                          <ComposedChart> 
                              <XAxis dataKey="index" type="number" domain={[0, MAX_DISPLAY_POINTS-1]} hide />
                               {chartMode === 'price' ? ( <Line type="monotone" dataKey="close" stroke="#777" dot={false} isAnimationActive={false} yAxisId="brushY" /> ) 
                               : ( <Area type="monotone" dataKey="marketCap" stroke="#777" fill="#666" fillOpacity={0.3} dot={false} isAnimationActive={false} yAxisId="brushY"/> )}
                              <YAxis hide domain={yAxisDomain} yAxisId="brushY" scale={chartMode === 'price' ? "log" : "linear"}/>
                          </ComposedChart>
                       </Brush>
                      )}
                </ComposedChart>
            </ResponsiveContainer>
        );
    };
  
    const intervalOptions = [ {label: '15s', value: 15 * 1000}, {label: '1m', value: 60 * 1000}, {label: '5m', value: 5 * 60 * 1000}, {label: '15m', value: 15 * 60 * 1000}];
    const modeOptions = [ {label: 'Price', value: 'price'}, {label: 'Market Cap', value: 'marketCap'}];

    return (
        <div className="bg-gray-900 p-4 sm:p-6 rounded-lg border border-gray-800 shadow-lg">
            <div className="flex flex-wrap justify-between items-center mb-2 gap-y-2"> <h2 className="text-lg sm:text-xl font-bold text-white mr-4">Live Pool Analytics</h2> <div className="flex items-center space-x-1 sm:space-x-2"> <span className="text-xs text-gray-400 mr-1">Mode:</span> {modeOptions.map(opt => ( <button key={opt.value} onClick={() => setChartMode(opt.value)} className={`text-xs px-2 py-1 rounded-md transition-colors ${chartMode === opt.value ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}> {opt.label} </button> ))} </div> <div className="flex items-center space-x-1 sm:space-x-2"> <span className="text-xs text-gray-400 mr-1">Interval:</span> {intervalOptions.map(opt => ( <button key={opt.value} onClick={() => setSelectedCandleIntervalMs(opt.value)} className={`text-xs px-2 py-1 rounded-md transition-colors ${selectedCandleIntervalMs === opt.value ? 'bg-indigo-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}> {opt.label} </button>))} </div> </div>
            
            {errorMsg && chartSourceData.length === 0 && !isInitialLoading && <p className="text-red-400 text-xs mb-2 text-center py-4">{errorMsg}</p>}
            {!tokenMint && <div className="text-gray-400 text-center py-10">Please load a token to see the chart.</div>}
            
            {tokenMint && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4 mb-4 text-xs sm:text-sm"> <div className="bg-gray-800 p-2 sm:p-3 rounded-lg"> <p className="text-gray-400 text-xs mb-0.5">Price</p> <p className="text-white font-semibold break-words">{currentPriceForStats.toPrecision(6)} SOL</p> <p className="text-green-400 text-xs mt-0.5"> {isLoadingSolPrice ? 'Loading USD...' : formatUsd(displayPriceUsd, true)} </p> </div> <div className="bg-gray-800 p-2 sm:p-3 rounded-lg"> <p className="text-gray-400 text-xs mb-0.5">Market Cap</p> <p className="text-white font-semibold break-words"> {currentMarketCap.toLocaleString(undefined, { maximumFractionDigits: 0})} SOL </p> <p className="text-green-400 text-xs mt-0.5"> {isLoadingSolPrice ? 'Loading USD...' : formatUsd(displayMarketCapUsd)} </p> </div> <div className="bg-gray-800 p-2 sm:p-3 rounded-lg"> <p className="text-gray-400 text-xs mb-0.5">LP Value</p> <p className="text-white font-semibold break-words"> {currentLpValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL </p> <p className="text-green-400 text-xs mt-0.5"> {isLoadingSolPrice ? 'Loading USD...' : formatUsd(displayLpValueUsd)} </p> </div> </div>
                    {renderChartContent()}
                </>
            )}
        </div>
    )
}
