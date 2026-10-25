import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { getKlines, createKlineWebSocket } from '../services/binanceApi';
import { useChartStore } from '../store/chartStore';
import { DrawingTools, Drawing } from './DrawingTools';

export function ChartComponent() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isRulerMode, setIsRulerMode] = useState(false);
  const [activeTool, setActiveTool] = useState('hline');
  const [color, setColor] = useState('#2962ff');
  const [lineWidth, setLineWidth] = useState(2);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);

  // Use refs for drawing state to avoid closure issues
  const isDrawingRef = useRef(false);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const middlePointRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const draggingPointIndexRef = useRef<number | null>(null);
  const selectedDrawingIdRef = useRef<string | null>(null);
  const drawingsRef = useRef<Drawing[]>([]);

  // Keep refs in sync with state
  useEffect(() => {
    selectedDrawingIdRef.current = selectedDrawingId;
  }, [selectedDrawingId]);

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  const { symbol, interval } = useChartStore();

  // Keep refs in sync with symbol and interval
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const colorRef = useRef(color);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  // Debounce timer for redraw
  const redrawTimerRef = useRef<number | null>(null);
  // Debounced redraw function
  const debouncedRedraw = () => {
    if (redrawTimerRef.current) {
      clearTimeout(redrawTimerRef.current);
    }
    redrawTimerRef.current = window.setTimeout(() => {
      redrawAll();
      redrawTimerRef.current = null;
    }, 16); // ~60fps
  };

  // Helper functions to convert between pixel and chart coordinates
  const pixelToChart = (x: number, y: number): { time: number; price: number } | null => {
    if (!chartRef.current || !candleSeriesRef.current) return null;
    const time = chartRef.current.timeScale().coordinateToTime(x);
    const price = candleSeriesRef.current.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { time: time as number, price };
  };

  const chartToPixel = (time: number, price: number): { x: number; y: number } | null => {
    if (!chartRef.current || !candleSeriesRef.current) return null;
    const x = chartRef.current.timeScale().timeToCoordinate(time as Time);
    const y = candleSeriesRef.current.priceToCoordinate(price);
    if (x === null || y === null) return null;
    return { x, y };
  };

  // No need for fixAllDrawings anymore - drawings are created with chart coordinates immediately

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: '#0a0e17' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350',
      borderDownColor: '#ef5350', borderUpColor: '#26a69a',
      wickDownColor: '#ef5350', wickUpColor: '#26a69a',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Initialize canvas size
    const initCanvas = () => {
      if (canvasRef.current && chartContainerRef.current) {
        canvasRef.current.width = chartContainerRef.current.clientWidth;
        canvasRef.current.height = chartContainerRef.current.clientHeight;
      }
    };

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
        initCanvas();
        redrawAll();
      }
    };
    window.addEventListener('resize', handleResize);

    // Subscribe to time scale changes to redraw fixed drawings with debounce
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      debouncedRedraw();
    });

    // Subscribe to crosshair move for price scale changes with debounce
    chart.subscribeCrosshairMove(() => {
      debouncedRedraw();
    });

    // Initialize canvas after a short delay to ensure it's rendered
    setTimeout(initCanvas, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (redrawTimerRef.current) {
        clearTimeout(redrawTimerRef.current);
      }
      chart.remove();
    };
  }, []);

  // Function to draw all saved drawings
  const redrawAll = () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Use refs to get current values
    const currentDrawings = drawingsRef.current;
    const currentSelectedId = selectedDrawingIdRef.current;

    // Draw all saved drawings for current symbol
    currentDrawings.forEach(drawing => {
      // Skip drawings from other symbols or drawings without symbol
      if (!drawing.symbol || drawing.symbol !== symbolRef.current) return;

      const isSelected = drawing.id === currentSelectedId;
      ctx.strokeStyle = drawing.color;
      ctx.lineWidth = drawing.lineWidth;
      ctx.setLineDash([]);

      // Convert points to pixel coordinates
      let pixels: { x: number; y: number }[];

      if (drawing.fixed) {
        // Convert chart coordinates (time/price stored in x/y) to pixels
        pixels = drawing.points.map(p => {
          const pixel = chartToPixel(p.x, p.y);
          return pixel || { x: 0, y: 0 };
        });
      } else {
        // Already in pixel coordinates
        pixels = drawing.points;
      }

      // Draw selection highlight
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = drawing.lineWidth + 2;
        ctx.setLineDash([5, 5]);
      }

      if (drawing.type === 'hline' && pixels.length >= 1) {
        const y = pixels[0].y;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      } else if (drawing.type === 'vline' && pixels.length >= 1) {
        const x = pixels[0].x;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      } else if (drawing.type === 'line' && pixels.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pixels[0].x, pixels[0].y);
        ctx.lineTo(pixels[1].x, pixels[1].y);
        ctx.stroke();
      } else if (drawing.type === 'ray' && pixels.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pixels[0].x, pixels[0].y);
        const dx = pixels[1].x - pixels[0].x;
        const dy = pixels[1].y - pixels[0].y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          const extendX = pixels[0].x + (dx / length) * 2000;
          const extendY = pixels[0].y + (dy / length) * 2000;
          ctx.lineTo(extendX, extendY);
        }
        ctx.stroke();
      } else if (drawing.type === 'fib' && pixels.length >= 2) {
        const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const y1 = pixels[0].y;
        const y2 = pixels[1].y;
        const x1 = pixels[0].x;
        const x2 = pixels[1].x;

        fibLevels.forEach(level => {
          // Invert level: 0% should be at y2 (end), 100% at y1 (start)
          const invertedLevel = 1 - level;
          const y = y1 + (y2 - y1) * invertedLevel;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();

          // Draw level label
          ctx.fillStyle = drawing.color;
          ctx.font = '10px sans-serif';
          ctx.fillText(`${(level * 100).toFixed(1)}%`, x2 + 5, y + 3);
        });
      } else if (drawing.type === 'rect' && pixels.length >= 2) {
        // Draw semi-transparent rectangle without border
        const x1 = pixels[0].x;
        const y1 = pixels[0].y;
        const x2 = pixels[1].x;
        const y2 = pixels[1].y;
        const width = x2 - x1;
        const height = y2 - y1;

        // Parse color and add transparency
        const tempColor = drawing.color;
        ctx.fillStyle = tempColor + '40'; // 25% opacity
        ctx.fillRect(x1, y1, width, height);
      } else if (drawing.type === 'channel' && pixels.length >= 3) {
        // Draw parallel channel
        // Point 0 and Point 1 define the center line
        // Point 2 defines the width (perpendicular distance to center line)
        const x1 = pixels[0].x;
        const y1 = pixels[0].y;
        const x2 = pixels[1].x;
        const y2 = pixels[1].y;
        const x3 = pixels[2].x;
        const y3 = pixels[2].y;

        // Calculate direction vector of the center line
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);

        if (length > 0) {
          // Calculate perpendicular distance from point 2 to the center line
          // Formula: |(y2-y1)*x3 - (x2-x1)*y3 + (x2-x1)*y1 - (y2-y1)*x1| / length
          const numerator = Math.abs((y2 - y1) * x3 - (x2 - x1) * y3 + (x2 - x1) * y1 - (y2 - y1) * x1);
          const halfWidth = numerator / length;

          // Calculate perpendicular unit vector
          const perpX = -dy / length;
          const perpY = dx / length;

          // Calculate offset for channel boundaries (symmetric around center line)
          const offsetX = perpX * halfWidth;
          const offsetY = perpY * halfWidth;

          // Draw semi-transparent fill between boundaries
          ctx.fillStyle = drawing.color + '30';
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.lineTo(x1 - offsetX, y1 - offsetY);
          ctx.closePath();
          ctx.fill();

          // Draw center line (point 0 to point 1)
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Draw upper boundary
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.stroke();

          // Draw lower boundary
          ctx.beginPath();
          ctx.moveTo(x1 - offsetX, y1 - offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.stroke();
        }
      } else if (drawing.type === 'ruler' && pixels.length >= 2) {
        // Draw ruler rectangle
        const startX = Math.min(pixels[0].x, pixels[1].x);
        const startY = Math.min(pixels[0].y, pixels[1].y);
        const width = Math.abs(pixels[1].x - pixels[0].x);
        const height = Math.abs(pixels[1].y - pixels[0].y);

        // Calculate price change to determine color
        let priceChange: number;
        if (drawing.fixed) {
          // For fixed drawings, use the stored prices directly
          // points[0] is start, points[1] is end
          priceChange = ((drawing.points[1].y - drawing.points[0].y) / drawing.points[0].y) * 100;
        } else {
          // For non-fixed, convert pixel y to price
          const price1 = candleSeriesRef.current?.coordinateToPrice(drawing.points[0].y);
          const price2 = candleSeriesRef.current?.coordinateToPrice(drawing.points[1].y);
          if (price1 !== null && price1 !== undefined && price2 !== null && price2 !== undefined) {
            priceChange = ((price2 - price1) / price1) * 100;
          } else {
            priceChange = 0;
          }
        }
        const isPositive = priceChange >= 0;

        // Ensure minimum visible size for 0% rulers
        const minVisibleHeight = 4;
        const effectiveHeight = Math.max(height, minVisibleHeight);
        const adjustedStartY = height < minVisibleHeight ? startY - minVisibleHeight / 2 : startY;

        // Fill rectangle with color based on direction
        ctx.fillStyle = isPositive ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)';
        ctx.fillRect(startX, adjustedStartY, width, effectiveHeight);

        // Stroke rectangle with color based on direction
        ctx.strokeStyle = isPositive ? '#26a69a' : '#ef5350';
        ctx.lineWidth = drawing.lineWidth;
        ctx.setLineDash([]);
        ctx.strokeRect(startX, adjustedStartY, width, effectiveHeight);

        // Calculate measurements
        const barCount = Math.abs(pixels[1].x - pixels[0].x);

        // Convert bars to time based on interval
        let timeText = '';
        if (intervalRef.current === '1m') timeText = `${barCount} мин`;
        else if (intervalRef.current === '5m') timeText = `${barCount * 5} мин`;
        else if (intervalRef.current === '15m') timeText = `${barCount * 15} мин`;
        else if (intervalRef.current === '30m') timeText = `${barCount * 30} мин`;
        else if (intervalRef.current === '1h') timeText = `${barCount} ч`;
        else if (intervalRef.current === '4h') timeText = `${barCount * 4} ч`;
        else if (intervalRef.current === '1d') timeText = `${barCount} дн`;
        else if (intervalRef.current === '1w') timeText = `${barCount} нед`;
        else timeText = `${barCount} баров`;

        // Draw measurement info
        const midX = startX + width / 2;
        const midY = startY + height / 2;

        // Background for text
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(midX - 60, midY - 25, 120, 50);

        // Color based on price change direction
        const percentColor = priceChange >= 0 ? '#26a69a' : '#ef5350';
        const percentText = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;

        // Text
        ctx.fillStyle = percentColor;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(percentText, midX, midY - 5);
        ctx.fillStyle = drawing.color;
        ctx.font = '12px sans-serif';
        ctx.fillText(timeText, midX, midY + 15);
        ctx.textAlign = 'left';
      }

      // Draw control points if selected
      if (isSelected) {
        pixels.forEach((point, idx) => {
          // Check if this point is being dragged
          const isBeingDragged = isDraggingRef.current && draggingPointIndexRef.current === idx;

          ctx.fillStyle = isBeingDragged ? '#ef4444' : '#3b82f6';
          ctx.beginPath();
          ctx.arc(point.x, point.y, isBeingDragged ? 7 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }

      // Restore context if drawing was selected
      if (isSelected) {
        ctx.restore();
      }
    });
  };

  // Redraw when drawings, selection, tool, or symbol changes
  useEffect(() => {
    redrawAll();
  }, [drawings, selectedDrawingId, activeTool, interval, symbol]);

  // Handle Delete key to remove selected or last drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete') {
        if (selectedDrawingId) {
          // Remove selected drawing
          setDrawings(prev => prev.filter(d => d.id !== selectedDrawingId));
          setSelectedDrawingId(null);
        } else if (drawings.length > 0) {
          // Remove last drawing
          setDrawings(prev => prev.slice(0, -1));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawings.length, selectedDrawingId]);

  // Handle canvas mouse events for drawing
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;

    // Reset state when not in drawing or ruler mode
    if (!isDrawingMode && !isRulerMode) {
      isDraggingRef.current = false;
      draggingPointIndexRef.current = null;
      canvas.style.cursor = 'default';
      return;
    }

    // Ruler mode has priority - if ruler is active, only ruler works
    if (isRulerMode) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.style.cursor = 'crosshair';

      const handleRulerMouseDown = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        isDrawingRef.current = true;
        startPointRef.current = { x, y };
      };

      const handleRulerMouseMove = (e: MouseEvent) => {
        if (!isDrawingRef.current || !startPointRef.current) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Redraw all saved drawings first
        redrawAll();

        // Draw ruler rectangle preview
        const startX = Math.min(startPointRef.current.x, x);
        const startY = Math.min(startPointRef.current.y, y);
        const width = Math.abs(x - startPointRef.current.x);
        const height = Math.abs(y - startPointRef.current.y);

        // Color based on price change direction - convert pixels to prices
        const startPrice = candleSeriesRef.current?.coordinateToPrice(startPointRef.current.y);
        const endPrice = candleSeriesRef.current?.coordinateToPrice(y);
        let priceChange = 0;
        if (startPrice !== null && startPrice !== undefined &&
            endPrice !== null && endPrice !== undefined &&
            startPrice !== 0) {
          priceChange = ((endPrice - startPrice) / startPrice) * 100;
        }
        const isPositive = priceChange >= 0;

        ctx.fillStyle = isPositive ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)';
        ctx.fillRect(startX, startY, width, height);
        ctx.strokeStyle = isPositive ? '#26a69a' : '#ef5350';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(startX, startY, width, height);

        // Calculate and display measurements
        const barCount = Math.abs(x - startPointRef.current.x);

        // Convert bars to time based on interval
        let timeText = '';
        if (intervalRef.current === '1m') timeText = `${barCount} мин`;
        else if (intervalRef.current === '5m') timeText = `${barCount * 5} мин`;
        else if (intervalRef.current === '15m') timeText = `${barCount * 15} мин`;
        else if (intervalRef.current === '30m') timeText = `${barCount * 30} мин`;
        else if (intervalRef.current === '1h') timeText = `${barCount} ч`;
        else if (intervalRef.current === '4h') timeText = `${barCount * 4} ч`;
        else if (intervalRef.current === '1d') timeText = `${barCount} дн`;
        else if (intervalRef.current === '1w') timeText = `${barCount} нед`;
        else timeText = `${barCount} баров`;

        // Display measurements
        const midX = startX + width / 2;
        const midY = startY + height / 2;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(midX - 60, midY - 25, 120, 50);

        // Color based on price change direction
        const percentColor = priceChange >= 0 ? '#26a69a' : '#ef5350';
        const percentText = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;

        ctx.fillStyle = percentColor;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(percentText, midX, midY - 5);
        ctx.fillStyle = colorRef.current;
        ctx.font = '12px sans-serif';
        ctx.fillText(timeText, midX, midY + 15);
        ctx.textAlign = 'left';
      };

      const handleRulerMouseUp = (e: MouseEvent) => {
        if (!isDrawingRef.current || !startPointRef.current) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Convert points to chart coordinates immediately
        const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);
        const endChartCoords = pixelToChart(x, y);

        // Create ruler drawing with chart coordinates
        if (startChartCoords && endChartCoords) {
          const newDrawing: Drawing = {
            id: Date.now().toString(),
            type: 'ruler',
            points: [
              { x: startChartCoords.time, y: startChartCoords.price },
              { x: endChartCoords.time, y: endChartCoords.price }
            ],
            color: colorRef.current,
            lineWidth: lineWidth,
            interval: interval, // Save current timeframe
            symbol: symbol, // Save current symbol
            fixed: true, // Mark as fixed immediately
          };

          setDrawings(prev => [...prev, newDrawing]);
        }

        isDrawingRef.current = false;
        startPointRef.current = null;
      };

      canvas.addEventListener('mousedown', handleRulerMouseDown);
      canvas.addEventListener('mousemove', handleRulerMouseMove);
      window.addEventListener('mouseup', handleRulerMouseUp);

      return () => {
        canvas.removeEventListener('mousedown', handleRulerMouseDown);
        canvas.removeEventListener('mousemove', handleRulerMouseMove);
        window.removeEventListener('mouseup', handleRulerMouseUp);
      };
    }

    // Handle selection in cursor mode
    if (activeTool === 'cursor') {
      const handleSelectClick = (e: MouseEvent) => {
        e.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if click is near any drawing
        const tolerance = 10;
        let foundDrawing: string | null = null;

        for (const drawing of drawings) {
          // Skip drawings from other symbols or drawings without symbol
          if (!drawing.symbol || drawing.symbol !== symbolRef.current) continue;

          // Convert points to pixel coordinates for selection check
          let pixels: { x: number; y: number }[];
          if (drawing.fixed) {
            pixels = drawing.points.map(p => {
              const pixel = chartToPixel(p.x, p.y);
              return pixel || { x: 0, y: 0 };
            });
          } else {
            pixels = drawing.points;
          }

          if (drawing.type === 'hline' && pixels.length >= 1) {
            const dy = Math.abs(y - pixels[0].y);
            if (dy < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'vline' && pixels.length >= 1) {
            const dx = Math.abs(x - pixels[0].x);
            if (dx < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'line' && pixels.length >= 2) {
            // Check distance to line segment
            const x1 = pixels[0].x;
            const y1 = pixels[0].y;
            const x2 = pixels[1].x;
            const y2 = pixels[1].y;

            const A = x - x1;
            const B = y - y1;
            const C = x2 - x1;
            const D = y2 - y1;

            const dot = A * C + B * D;
            const len_sq = C * C + D * D;
            const param = len_sq !== 0 ? dot / len_sq : -1;

            let xx, yy;

            if (param < 0) {
              xx = x1;
              yy = y1;
            } else if (param > 1) {
              xx = x2;
              yy = y2;
            } else {
              xx = x1 + param * C;
              yy = y1 + param * D;
            }

            const dx = x - xx;
            const dy = y - yy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'ray' && pixels.length >= 2) {
            // Check distance to ray (line segment from start point)
            const x1 = pixels[0].x;
            const y1 = pixels[0].y;
            const x2 = pixels[1].x;
            const y2 = pixels[1].y;

            const A = x - x1;
            const B = y - y1;
            const C = x2 - x1;
            const D = y2 - y1;

            const dot = A * C + B * D;
            const len_sq = C * C + D * D;
            const param = len_sq !== 0 ? dot / len_sq : -1;

            let xx, yy;

            if (param < 0) {
              xx = x1;
              yy = y1;
            } else {
              xx = x1 + param * C;
              yy = y1 + param * D;
            }

            const dx = x - xx;
            const dy = y - yy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'fib' && pixels.length >= 2) {
            // Check if click is near any of the fibonacci levels
            const y1 = pixels[0].y;
            const y2 = pixels[1].y;
            const x1 = pixels[0].x;
            const x2 = pixels[1].x;

            const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

            for (const level of fibLevels) {
              const fy = y1 + (y2 - y1) * level;
              const dy = Math.abs(y - fy);
              if (dy < tolerance && x >= Math.min(x1, x2) && x <= Math.max(x1, x2)) {
                foundDrawing = drawing.id;
                break;
              }
            }
            if (foundDrawing) break;
          } else if (drawing.type === 'rect' && pixels.length >= 2) {
            // Check if click is inside or near rectangle
            const x1 = pixels[0].x;
            const y1 = pixels[0].y;
            const x2 = pixels[1].x;
            const y2 = pixels[1].y;

            const minX = Math.min(x1, x2);
            const maxX = Math.max(x1, x2);
            const minY = Math.min(y1, y2);
            const maxY = Math.max(y1, y2);

            // Check if click is inside rectangle
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              foundDrawing = drawing.id;
              break;
            }

            // Check if click is near edges
            const nearTop = Math.abs(y - minY) < tolerance && x >= minX && x <= maxX;
            const nearBottom = Math.abs(y - maxY) < tolerance && x >= minX && x <= maxX;
            const nearLeft = Math.abs(x - minX) < tolerance && y >= minY && y <= maxY;
            const nearRight = Math.abs(x - maxX) < tolerance && y >= minY && y <= maxY;

            if (nearTop || nearBottom || nearLeft || nearRight) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'channel' && pixels.length >= 3) {
            // Check if click is inside the channel fill or near any of the 3 channel lines
            const x1 = pixels[0].x;
            const y1 = pixels[0].y;
            const x2 = pixels[1].x;
            const y2 = pixels[1].y;
            const x3 = pixels[2].x;
            const y3 = pixels[2].y;

            const dx = x2 - x1;
            const dy = y2 - y1;
            const length = Math.sqrt(dx * dx + dy * dy);

            if (length > 0) {
              // Calculate perpendicular distance from third point to the line
              const perpDist = Math.abs((y2 - y1) * x3 - (x2 - x1) * y3 + x2 * y1 - y2 * x1) / length;
              const offsetX = -dy / length * perpDist;
              const offsetY = dx / length * perpDist;

              // Check if click is inside the filled channel area
              // Use point-in-polygon test for the parallelogram
              const corners = [
                { x: x1 + offsetX, y: y1 + offsetY },
                { x: x2 + offsetX, y: y2 + offsetY },
                { x: x2 - offsetX, y: y2 - offsetY },
                { x: x1 - offsetX, y: y1 - offsetY }
              ];

              // Simple bounding box check first
              const minX = Math.min(...corners.map(c => c.x));
              const maxX = Math.max(...corners.map(c => c.x));
              const minY = Math.min(...corners.map(c => c.y));
              const maxY = Math.max(...corners.map(c => c.y));

              if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                foundDrawing = drawing.id;
                break;
              }

              // Check middle line
              const A1 = x - x1;
              const B1 = y - y1;
              const C1 = dx;
              const D1 = dy;
              const dot1 = A1 * C1 + B1 * D1;
              const len_sq1 = C1 * C1 + D1 * D1;
              const param1 = len_sq1 !== 0 ? dot1 / len_sq1 : -1;

              let xx1, yy1;
              if (param1 < 0) {
                xx1 = x1;
                yy1 = y1;
              } else if (param1 > 1) {
                xx1 = x2;
                yy1 = y2;
              } else {
                xx1 = x1 + param1 * C1;
                yy1 = y1 + param1 * D1;
              }

              const dist1 = Math.sqrt((x - xx1) ** 2 + (y - yy1) ** 2);
              if (dist1 < tolerance) {
                foundDrawing = drawing.id;
                break;
              }

              // Check upper line
              const ux1 = x1 + offsetX;
              const uy1 = y1 + offsetY;
              const ux2 = x2 + offsetX;
              const uy2 = y2 + offsetY;

              const A2 = x - ux1;
              const B2 = y - uy1;
              const dot2 = A2 * C1 + B2 * D1;
              const param2 = len_sq1 !== 0 ? dot2 / len_sq1 : -1;

              let xx2, yy2;
              if (param2 < 0) {
                xx2 = ux1;
                yy2 = uy1;
              } else if (param2 > 1) {
                xx2 = ux2;
                yy2 = uy2;
              } else {
                xx2 = ux1 + param2 * C1;
                yy2 = uy1 + param2 * D1;
              }

              const dist2 = Math.sqrt((x - xx2) ** 2 + (y - yy2) ** 2);
              if (dist2 < tolerance) {
                foundDrawing = drawing.id;
                break;
              }

              // Check lower line
              const lx1 = x1 - offsetX;
              const ly1 = y1 - offsetY;
              const lx2 = x2 - offsetX;
              const ly2 = y2 - offsetY;

              const A3 = x - lx1;
              const B3 = y - ly1;
              const dot3 = A3 * C1 + B3 * D1;
              const param3 = len_sq1 !== 0 ? dot3 / len_sq1 : -1;

              let xx3, yy3;
              if (param3 < 0) {
                xx3 = lx1;
                yy3 = ly1;
              } else if (param3 > 1) {
                xx3 = lx2;
                yy3 = ly2;
              } else {
                xx3 = lx1 + param3 * C1;
                yy3 = ly1 + param3 * D1;
              }

              const dist3 = Math.sqrt((x - xx3) ** 2 + (y - yy3) ** 2);
              if (dist3 < tolerance) {
                foundDrawing = drawing.id;
                break;
              }
            }
          } else if (drawing.type === 'ruler' && pixels.length >= 2) {
            // Check if click is near any of the ruler's control points or inside the rectangle
            const p1 = pixels[0];
            const p2 = pixels[1];

            // Check distance to control points (very generous for rulers)
            const pointRadius = 20;
            const dist1 = Math.sqrt((x - p1.x) ** 2 + (y - p1.y) ** 2);
            const dist2 = Math.sqrt((x - p2.x) ** 2 + (y - p2.y) ** 2);

            if (dist1 < pointRadius || dist2 < pointRadius) {
              foundDrawing = drawing.id;
              break;
            }

            // Check if click is inside ruler rectangle
            const startX = Math.min(p1.x, p2.x);
            const startY = Math.min(p1.y, p2.y);
            const width = Math.abs(p2.x - p1.x);
            const height = Math.abs(p2.y - p1.y);

            // Add minimum clickable area for very small rectangles (especially 0% rulers)
            const minWidth = 60;
            const minHeight = 60;
            const effectiveWidth = Math.max(width, minWidth);
            const effectiveHeight = Math.max(height, minHeight);

            // Center the clickable area if the actual rectangle is smaller
            const clickableStartX = startX - (effectiveWidth - width) / 2;
            const clickableStartY = startY - (effectiveHeight - height) / 2;

            if (x >= clickableStartX && x <= clickableStartX + effectiveWidth &&
                y >= clickableStartY && y <= clickableStartY + effectiveHeight) {
              foundDrawing = drawing.id;
              break;
            }
          }
        }

        setSelectedDrawingId(foundDrawing);
        redrawAll();
      };
      // Handle editing (dragging points)
      const handleMouseDown = (e: MouseEvent) => {
        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) return;

        e.preventDefault();
        e.stopPropagation();

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const drawing = drawingsRef.current.find(d => d.id === currentSelectedId);
        if (!drawing) return;

        // Skip drawings from other timeframes
        // Skip drawings from other symbols or drawings without symbol
        if (!drawing.symbol || drawing.symbol !== symbolRef.current) return;

        // Convert points to pixel coordinates for hit testing
        let pixels: { x: number; y: number }[];
        if (drawing.fixed) {
          pixels = drawing.points.map(p => {
            const pixel = chartToPixel(p.x, p.y);
            return pixel || { x: 0, y: 0 };
          });
        } else {
          pixels = drawing.points;
        }

        // Check if click is near any point
        const pointRadius = 10;
        for (let i = 0; i < pixels.length; i++) {
          const point = pixels[i];
          const dx = x - point.x;
          const dy = y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < pointRadius) {
            isDraggingRef.current = true;
            draggingPointIndexRef.current = i;
            canvas.style.cursor = 'grabbing';
            break;
          }
        }
      };

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDraggingRef.current || draggingPointIndexRef.current === null) return;

        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) return;

        e.preventDefault();

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Update the point position
        setDrawings(prev => prev.map(d => {
          if (d.id === currentSelectedId) {
            const newPoints = [...d.points];

            if (d.fixed) {
              // Convert pixel coordinates to chart coordinates
              const chartCoords = pixelToChart(x, y);
              if (chartCoords) {
                newPoints[draggingPointIndexRef.current!] = { x: chartCoords.time, y: chartCoords.price };
              }
            } else {
              // Keep in pixel coordinates
              newPoints[draggingPointIndexRef.current!] = { x, y };
            }

            return { ...d, points: newPoints };
          }
          return d;
        }));
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        draggingPointIndexRef.current = null;
        canvas.style.cursor = 'pointer';
      };

      // Handle hover over control points
      const handleMouseHover = (e: MouseEvent) => {
        if (isDraggingRef.current) return;

        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) {
          canvas.style.cursor = 'pointer';
          return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const drawing = drawingsRef.current.find(d => d.id === currentSelectedId);
        if (!drawing) {
          canvas.style.cursor = 'pointer';
          return;
        }

        // Skip drawings from other symbols or drawings without symbol
        if (!drawing.symbol || drawing.symbol !== symbolRef.current) {
          canvas.style.cursor = 'pointer';
          return;
        }

        // Convert points to pixel coordinates for hit testing
        let pixels: { x: number; y: number }[];
        if (drawing.fixed) {
          pixels = drawing.points.map(p => {
            const pixel = chartToPixel(p.x, p.y);
            return pixel || { x: 0, y: 0 };
          });
        } else {
          pixels = drawing.points;
        }

        // Check if mouse is near any point
        const pointRadius = 10;
        let nearPoint = false;

        for (let i = 0; i < pixels.length; i++) {
          const point = pixels[i];
          const dx = x - point.x;
          const dy = y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < pointRadius) {
            nearPoint = true;
            break;
          }
        }

        canvas.style.cursor = nearPoint ? 'grab' : 'pointer';
      };

      canvas.addEventListener('click', handleSelectClick);
      canvas.addEventListener('mousedown', handleMouseDown);
      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mousemove', handleMouseHover);
      // Listen to mouseup on window to catch releases outside canvas
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        canvas.removeEventListener('click', handleSelectClick);
        canvas.removeEventListener('mousedown', handleMouseDown);
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mousemove', handleMouseHover);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }

    // Drawing mode handlers
    const handleDrawMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // For channel, handle 3-click logic differently
      if (activeTool === 'channel') {
        if (!startPointRef.current) {
          // First click - set start point
          startPointRef.current = { x, y };
          isDrawingRef.current = true;
        } else if (!middlePointRef.current) {
          // Second click - set middle point
          middlePointRef.current = { x, y };
          // Don't reset isDrawingRef, we're still drawing
        } else {
          // Third click - create channel with chart coordinates
          const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);
          const middleChartCoords = pixelToChart(middlePointRef.current.x, middlePointRef.current.y);
          const endChartCoords = pixelToChart(x, y);

          if (startChartCoords && middleChartCoords && endChartCoords) {
            const newDrawing: Drawing = {
              id: Date.now().toString(),
              type: 'channel',
              points: [
                { x: startChartCoords.time, y: startChartCoords.price },
                { x: middleChartCoords.time, y: middleChartCoords.price },
                { x: endChartCoords.time, y: endChartCoords.price }
              ],
              color: colorRef.current,
              lineWidth: lineWidth,
              interval: interval,
              symbol: symbol, // Save current symbol
              fixed: true, // Mark as fixed immediately
            };

            setDrawings(prev => [...prev, newDrawing]);
          }

          // Reset all state
          isDrawingRef.current = false;
          startPointRef.current = null;
          middlePointRef.current = null;
        }
        return;
      }

      // For other tools, use normal logic
      isDrawingRef.current = true;
      startPointRef.current = { x, y };
    };

    const handleDrawMouseMove = (e: MouseEvent) => {
      // For channel, need at least start point
      if (activeTool === 'channel') {
        if (!startPointRef.current) return;
      } else {
        // For other tools, need start point and drawing active
        if (!isDrawingRef.current || !startPointRef.current) return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Redraw all saved drawings first
      redrawAll();

      // Draw preview
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([5, 5]);

      if (activeTool === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      } else if (activeTool === 'vline') {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      } else if (activeTool === 'line') {
        ctx.beginPath();
        ctx.moveTo(startPointRef.current.x, startPointRef.current.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else if (activeTool === 'ray') {
        ctx.beginPath();
        ctx.moveTo(startPointRef.current.x, startPointRef.current.y);
        const dx = x - startPointRef.current.x;
        const dy = y - startPointRef.current.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          const extendX = startPointRef.current.x + (dx / length) * 2000;
          const extendY = startPointRef.current.y + (dy / length) * 2000;
          ctx.lineTo(extendX, extendY);
        }
        ctx.stroke();
      } else if (activeTool === 'fib') {
        const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const y1 = startPointRef.current.y;
        const x1 = startPointRef.current.x;

        fibLevels.forEach(level => {
          // Invert level: 0% should be at y (end), 100% at y1 (start)
          const invertedLevel = 1 - level;
          const fy = y1 + (y - y1) * invertedLevel;
          ctx.beginPath();
          ctx.moveTo(x1, fy);
          ctx.lineTo(x, fy);
          ctx.stroke();
        });
      } else if (activeTool === 'rect') {
        // Draw semi-transparent rectangle preview without border
        const x1 = startPointRef.current.x;
        const y1 = startPointRef.current.y;
        const width = x - x1;
        const height = y - y1;

        ctx.fillStyle = colorRef.current + '40'; // 25% opacity
        ctx.fillRect(x1, y1, width, height);
      } else if (activeTool === 'channel') {
        // Draw parallel channel preview
        const x1 = startPointRef.current.x;
        const y1 = startPointRef.current.y;

        // If middle point is set, draw channel from start to middle
        let x2, y2;
        if (middlePointRef.current) {
          x2 = middlePointRef.current.x;
          y2 = middlePointRef.current.y;
        } else {
          x2 = x;
          y2 = y;
        }

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);

        if (length > 0) {
          // Calculate perpendicular distance from current mouse position to the line
          let perpDist;

          if (middlePointRef.current) {
            // After second click, use distance from mouse to line as width
            const numerator = Math.abs((y2 - y1) * x - (x2 - x1) * y + (x2 - x1) * y1 - (y2 - y1) * x1);
            perpDist = numerator / length;
          } else {
            // Before second click, use 30% of line length as preview width
            perpDist = length * 0.3;
          }

          // Calculate perpendicular unit vector
          const perpX = -dy / length;
          const perpY = dx / length;

          // Calculate offset for channel boundaries (symmetric around center line)
          const offsetX = perpX * perpDist;
          const offsetY = perpY * perpDist;

          // Semi-transparent fill
          ctx.fillStyle = colorRef.current + '30';
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.lineTo(x1 - offsetX, y1 - offsetY);
          ctx.closePath();
          ctx.fill();

          // Middle line
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Upper line
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.stroke();

          // Lower line
          ctx.beginPath();
          ctx.moveTo(x1 - offsetX, y1 - offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.stroke();
        }
      }

      ctx.setLineDash([]);
    };

    const handleDrawMouseUp = (e: MouseEvent) => {
      // Skip channel logic - handled in mousedown
      if (activeTool === 'channel') return;

      if (!isDrawingRef.current || !startPointRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert end point to chart coordinates immediately
      const endChartCoords = pixelToChart(x, y);
      const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);

      // Create new drawing for other tools with chart coordinates
      const newDrawing: Drawing = {
        id: Date.now().toString(),
        type: activeTool,
        points: [],
        color: colorRef.current,
        lineWidth: lineWidth,
        interval: interval, // Save current timeframe
        symbol: symbol, // Save current symbol
        fixed: true, // Mark as fixed immediately
      };

      if (activeTool === 'hline') {
        if (endChartCoords) {
          newDrawing.points = [{ x: endChartCoords.time, y: endChartCoords.price }];
        }
      } else if (activeTool === 'vline') {
        if (endChartCoords) {
          newDrawing.points = [{ x: endChartCoords.time, y: endChartCoords.price }];
        }
      } else if (activeTool === 'line' || activeTool === 'ray' || activeTool === 'fib' || activeTool === 'rect') {
        if (startChartCoords && endChartCoords) {
          newDrawing.points = [
            { x: startChartCoords.time, y: startChartCoords.price },
            { x: endChartCoords.time, y: endChartCoords.price }
          ];
        }
      }

      // Save drawing only if we have valid points
      if (newDrawing.points.length > 0) {
        setDrawings(prev => [...prev, newDrawing]);
      }

      isDrawingRef.current = false;
      startPointRef.current = null;
    };

    canvas.addEventListener('mousedown', handleDrawMouseDown);
    canvas.addEventListener('mousemove', handleDrawMouseMove);
    canvas.addEventListener('mouseup', handleDrawMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', handleDrawMouseDown);
      canvas.removeEventListener('mousemove', handleDrawMouseMove);
      canvas.removeEventListener('mouseup', handleDrawMouseUp);
    };
  }, [isDrawingMode, isRulerMode, activeTool]);

  // Save drawings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('chartDrawings', JSON.stringify(drawings));
  }, [drawings]);

  // Adapt drawings to new timeframe
  const adaptDrawingsToTimeframe = useCallback((newKlines: { time: number }[]) => {
    if (newKlines.length === 0) return;

    setDrawings(prevDrawings => {
      return prevDrawings.map(drawing => {
        if (!drawing.fixed) return drawing; // Only adapt fixed drawings

        // For horizontal lines, keep the price, just update time to middle of visible range
        if (drawing.type === 'hline' && drawing.points.length >= 1) {
          const price = drawing.points[0].y;
          // Find middle candle in new timeframe
          const middleIndex = Math.floor(newKlines.length / 2);
          const middleTime = newKlines[middleIndex].time / 1000; // Convert ms to seconds

          return {
            ...drawing,
            points: [{ x: middleTime, y: price }]
          };
        }

        // For vertical lines, find closest candle to the time
        if (drawing.type === 'vline' && drawing.points.length >= 1) {
          const time = drawing.points[0].x;

          // Find closest candle
          let closestCandle = newKlines[0];
          let minDistance = Math.abs(time - newKlines[0].time / 1000);

          for (const candle of newKlines) {
            const distance = Math.abs(time - candle.time / 1000);
            if (distance < minDistance) {
              minDistance = distance;
              closestCandle = candle;
            }
          }

          return {
            ...drawing,
            points: [{ x: closestCandle.time / 1000, y: drawing.points[0].y }]
          };
        }

        // For other drawings, adapt all points to closest candles
        const adaptedPoints = drawing.points.map(point => {
          const time = point.x;
          const price = point.y;

          // Find closest candle by time
          let closestCandle = newKlines[0];
          let minDistance = Math.abs(time - newKlines[0].time / 1000);

          for (const candle of newKlines) {
            const distance = Math.abs(time - candle.time / 1000);
            if (distance < minDistance) {
              minDistance = distance;
              closestCandle = candle;
            }
          }

          return {
            x: closestCandle.time / 1000,
            y: price
          };
        });

        return {
          ...drawing,
          points: adaptedPoints
        };
      });
    });
  }, []);

  // Load data
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load 2000 candles (will make multiple requests if needed)
        const data = await getKlines(symbol, interval, 2000);

        // Adapt drawings to new timeframe
        adaptDrawingsToTimeframe(data);

        if (candleSeriesRef.current && chartRef.current) {
          const candleData = data.map(d => ({
            time: (d.time / 1000) as Time, open: d.open, high: d.high, low: d.low, close: d.close,
          }));
          const volumeData = data.map(d => ({
            time: (d.time / 1000) as Time, value: d.volume,
            color: d.close >= d.open ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)',
          }));

          candleSeriesRef.current.setData(candleData);
          volumeSeriesRef.current?.setData(volumeData);

          // Auto-fit content only when symbol/interval changes
          chartRef.current.timeScale().fitContent();

          // Ensure price scale auto-adjusts to new data
          chartRef.current.priceScale('right').applyOptions({
            autoScale: true,
          });

          // Force redraw after data load to show drawings for current timeframe
          setTimeout(() => {
            redrawAll();
          }, 50);
        }
      } catch (e) {
        console.error('Failed to load klines:', e);
      }
    };

    loadData();

    // WebSocket
    if (wsRef.current) wsRef.current.close();
    wsRef.current = createKlineWebSocket(symbol, interval, (kline) => {
      if (candleSeriesRef.current) {
        const timeInSeconds = Math.floor(kline.time / 1000);
        candleSeriesRef.current.update({
          time: timeInSeconds as Time,
          open: kline.open, high: kline.high, low: kline.low, close: kline.close,
        });
      }
    });

    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [symbol, interval, adaptDrawingsToTimeframe]);

  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      {/* Main Chart Area */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Drawing Tools Sidebar */}
        <DrawingTools
          activeTool={activeTool}
          onToolSelect={setActiveTool}
          isDrawingMode={isDrawingMode}
          onToggleDrawingMode={() => {
            setIsDrawingMode(!isDrawingMode);
            if (!isDrawingMode) {
              setActiveTool('hline');
            }
          }}
          color={color}
          onColorChange={setColor}
          lineWidth={lineWidth}
          onLineWidthChange={setLineWidth}
          drawings={drawings}
          onDeleteDrawing={(id) => {
            setDrawings(prev => prev.filter(d => d.id !== id));
            if (selectedDrawingId === id) {
              setSelectedDrawingId(null);
            }
          }}
          onClearAll={() => {
            setDrawings([]);
            setSelectedDrawingId(null);
          }}
          selectedDrawingId={selectedDrawingId}
          onSelectDrawing={setSelectedDrawingId}
          isRulerMode={isRulerMode}
          onToggleRulerMode={() => {
            setIsRulerMode(!isRulerMode);
          }}
        />

        {/* Chart Area */}
        <div className="flex-1 relative">
          <div ref={chartContainerRef} className="w-full h-full" />

          {/* Canvas Overlay for Drawing - always rendered, controlled by pointer-events */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 z-10"
            style={{
              pointerEvents: (isDrawingMode || isRulerMode) ? 'auto' : 'none',
              cursor: isRulerMode ? 'crosshair' : (isDrawingMode ? (activeTool === 'cursor' ? 'pointer' : 'crosshair') : 'default')
            }}
          />
        </div>
      </div>

      {/* Order Book Depth Panel - Permanent */}
      <div className="h-32 bg-[#131722] border-t border-[#2a2e39] flex items-center justify-center shrink-0">
        <div className="text-gray-500 text-sm">Order Book Depth Panel</div>
      </div>
    </div>
  );
}
