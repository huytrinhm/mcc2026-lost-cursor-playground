const IMAGE_NAMES = ["01", "02", "03", "04", "05", "06", "07", "08"];
const MOVE_LIMIT = 5000;
const DETAIL_WINDOW_SIZE = 50;
const DETAIL_PAN_STEP = 5;
const MOVE_DELTAS = {
  U: { dr: -1, dc: 0 },
  D: { dr: 1, dc: 0 },
  L: { dr: 0, dc: -1 },
  R: { dr: 0, dc: 1 },
};

const refs = {
  imageList: document.getElementById("imageList"),
  loadingLabel: document.getElementById("loadingLabel"),
  activeImageTitle: document.getElementById("activeImageTitle"),
  activeImageStats: document.getElementById("activeImageStats"),
  lengthLabel: document.getElementById("lengthLabel"),
  hoverLabel: document.getElementById("hoverLabel"),
  boardWrap: document.getElementById("boardWrap"),
  boardCanvas: document.getElementById("boardCanvas"),
  detailLabel: document.getElementById("detailLabel"),
  detailWrap: document.getElementById("detailWrap"),
  detailCanvas: document.getElementById("detailCanvas"),
  sequenceInput: document.getElementById("sequenceInput"),
  undoButton: document.getElementById("undoButton"),
  clearButton: document.getElementById("clearButton"),
  centerButton: document.getElementById("centerButton"),
  focusEndpointButton: document.getElementById("focusEndpointButton"),
};

const boardCtx = refs.boardCanvas.getContext("2d");
const detailCtx = refs.detailCanvas.getContext("2d");
const imageCache = new Map();
const sessions = new Map();
const thumbButtons = new Map();
const resizeObserver = new ResizeObserver(() => scheduleRender());

let currentImageName = IMAGE_NAMES[0];
let isSyncingSequenceField = false;
let renderScheduled = false;
let detailInteraction = null;

function createSession() {
  return {
    moves: "",
    anchor: null,
    trail: [],
    detailView: null,
    survivorStarts: null,
    currentPositions: null,
    survivorCount: 0,
  };
}

function getSession(imageName) {
  if (!sessions.has(imageName)) {
    sessions.set(imageName, createSession());
  }
  return sessions.get(imageName);
}

function sanitizeMoves(input) {
  return input.toUpperCase().replace(/[^UDLR]/g, "");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function indexToRowCol(index, size) {
  return {
    row: Math.floor(index / size),
    col: index % size,
  };
}

function rowColToIndex(row, col, size) {
  return row * size + col;
}

function defaultAnchor(size) {
  const mid = Math.floor(size / 2);
  return { row: mid, col: mid };
}

function cloneCell(cell) {
  return { row: cell.row, col: cell.col };
}

function ensureAnchor(session, size) {
  if (!session.anchor) {
    session.anchor = defaultAnchor(size);
  }
}

function getDetailWindowSize(imageState) {
  return Math.min(DETAIL_WINDOW_SIZE, imageState.size);
}

function clampDetailView(detailView, imageState) {
  const windowSize = getDetailWindowSize(imageState);
  const maxStart = imageState.size - windowSize;
  detailView.topRow = clamp(detailView.topRow, 0, maxStart);
  detailView.leftCol = clamp(detailView.leftCol, 0, maxStart);
}

function centerDetailViewOnCell(session, imageState, cell) {
  const windowSize = getDetailWindowSize(imageState);
  const maxStart = imageState.size - windowSize;
  session.detailView = {
    topRow: clamp(cell.row - Math.floor(windowSize / 2), 0, maxStart),
    leftCol: clamp(cell.col - Math.floor(windowSize / 2), 0, maxStart),
  };
}

function ensureDetailView(session, imageState) {
  if (!session.detailView) {
    const focusCell = session.trail.length
      ? session.trail[session.trail.length - 1]
      : session.anchor || defaultAnchor(imageState.size);
    centerDetailViewOnCell(session, imageState, focusCell);
  } else {
    clampDetailView(session.detailView, imageState);
  }
}

function getTrailEndpoint(session, size) {
  if (session.trail.length) {
    return session.trail[session.trail.length - 1];
  }
  ensureAnchor(session, size);
  return session.anchor;
}

function moveIndex(index, move, size) {
  const row = Math.floor(index / size);
  const col = index % size;
  const delta = MOVE_DELTAS[move];
  const nextRow = clamp(row + delta.dr, 0, size - 1);
  const nextCol = clamp(col + delta.dc, 0, size - 1);
  return nextRow * size + nextCol;
}

function extendTrail(session, size, move) {
  if (!session.trail.length) {
    ensureAnchor(session, size);
    session.trail = [cloneCell(session.anchor)];
  }
  const last = session.trail[session.trail.length - 1];
  const delta = MOVE_DELTAS[move];
  const next = {
    row: clamp(last.row + delta.dr, 0, size - 1),
    col: clamp(last.col + delta.dc, 0, size - 1),
  };
  session.trail.push(next);
}

function rebuildTrail(session, size) {
  ensureAnchor(session, size);
  session.trail = [cloneCell(session.anchor)];
  for (const move of session.moves) {
    extendTrail(session, size, move);
  }
}

function resetSimulation(session, imageState) {
  const totalWhite = imageState.whiteStarts.length;
  if (!session.survivorStarts || session.survivorStarts.length !== totalWhite) {
    session.survivorStarts = new Uint32Array(totalWhite);
    session.currentPositions = new Uint32Array(totalWhite);
  }
  session.survivorStarts.set(imageState.whiteStarts);
  session.currentPositions.set(imageState.whiteStarts);
  session.survivorCount = totalWhite;
}

function applyStep(session, imageState, move) {
  let nextCount = 0;
  for (let i = 0; i < session.survivorCount; i += 1) {
    const nextPosition = moveIndex(session.currentPositions[i], move, imageState.size);
    if (!imageState.isBlack[nextPosition]) {
      session.survivorStarts[nextCount] = session.survivorStarts[i];
      session.currentPositions[nextCount] = nextPosition;
      nextCount += 1;
    }
  }
  session.survivorCount = nextCount;
}

function recomputeSession(session, imageState) {
  ensureAnchor(session, imageState.size);
  rebuildTrail(session, imageState.size);
  ensureDetailView(session, imageState);
  resetSimulation(session, imageState);
  for (const move of session.moves) {
    applyStep(session, imageState, move);
  }
  updateMask(imageState, session);
}

function updateMask(imageState, session) {
  imageState.maskPixels.fill(0);
  for (let i = 0; i < session.survivorCount; i += 1) {
    const pixelOffset = session.survivorStarts[i] * 4;
    imageState.maskPixels[pixelOffset] = 228;
    imageState.maskPixels[pixelOffset + 1] = 88;
    imageState.maskPixels[pixelOffset + 2] = 88;
    imageState.maskPixels[pixelOffset + 3] = 130;
  }
  imageState.maskCtx.putImageData(imageState.maskImageData, 0, 0);
}

async function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

async function loadImageState(name) {
  if (imageCache.has(name)) {
    return imageCache.get(name);
  }

  refs.loadingLabel.textContent = "Loading...";

  const image = await loadImage(`images/${name}.png`);
  const size = image.width;
  const total = size * size;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = size;
  sourceCanvas.height = size;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(image, 0, 0);
  const sourceData = sourceCtx.getImageData(0, 0, size, size).data;

  const isBlack = new Uint8Array(total);
  const whiteStartList = [];
  let blackCount = 0;

  for (let i = 0; i < total; i += 1) {
    const channel = sourceData[i * 4];
    const black = channel < 128 ? 1 : 0;
    isBlack[i] = black;
    if (black) {
      blackCount += 1;
    } else {
      whiteStartList.push(i);
    }
  }

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = size;
  maskCanvas.height = size;
  const maskCtx = maskCanvas.getContext("2d");
  const maskImageData = maskCtx.createImageData(size, size);

  const imageState = {
    name,
    image,
    size,
    total,
    blackCount,
    whiteCount: whiteStartList.length,
    isBlack,
    whiteStarts: Uint32Array.from(whiteStartList),
    sourceCanvas,
    maskCanvas,
    maskCtx,
    maskImageData,
    maskPixels: maskImageData.data,
  };

  imageCache.set(name, imageState);
  refs.loadingLabel.textContent = "Ready";
  return imageState;
}

function buildImageSelector() {
  const fragment = document.createDocumentFragment();

  for (const name of IMAGE_NAMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-option";
    button.dataset.name = name;
    button.innerHTML = `
      <img src="images/${name}.png" alt="Input image ${name}">
      <div class="image-meta">
        <span>${name}.png</span>
        <span>${name === "06" ? "495" : "500"} px</span>
      </div>
    `;
    button.addEventListener("click", () => switchImage(name));
    fragment.appendChild(button);
    thumbButtons.set(name, button);
  }

  refs.imageList.appendChild(fragment);
}

function syncImageSelectionUI() {
  for (const [name, button] of thumbButtons.entries()) {
    button.classList.toggle("active", name === currentImageName);
  }
}

function syncSequenceField(session) {
  isSyncingSequenceField = true;
  refs.sequenceInput.value = session.moves;
  isSyncingSequenceField = false;
}

function syncDetailLabel(imageState, session) {
  ensureDetailView(session, imageState);
  const windowSize = getDetailWindowSize(imageState);
  const rowEnd = session.detailView.topRow + windowSize;
  const colEnd = session.detailView.leftCol + windowSize;
  refs.detailLabel.textContent =
    `R ${session.detailView.topRow + 1}-${rowEnd} C ${session.detailView.leftCol + 1}-${colEnd}`;
}

function syncStats(imageState, session) {
  const coveredCount = imageState.whiteCount - session.survivorCount;

  refs.activeImageTitle.textContent = `${imageState.name}.png`;
  refs.activeImageStats.textContent =
    `${session.moves.length.toLocaleString()} moves - ${coveredCount.toLocaleString()} / ${imageState.whiteCount.toLocaleString()} pixels`;
  refs.lengthLabel.textContent = `${session.moves.length.toLocaleString()} / ${MOVE_LIMIT}`;
  refs.lengthLabel.style.background = session.moves.length > MOVE_LIMIT ? "#fde8e8" : "#edf6f1";
  refs.lengthLabel.style.color = session.moves.length > MOVE_LIMIT ? "#9e2f2f" : "var(--accent-strong)";
}

function scheduleRender() {
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderBoard();
    renderDetailEditor();
  });
}

function resizeCanvasToDisplaySize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderBoard() {
  const imageState = imageCache.get(currentImageName);
  if (!imageState) {
    return;
  }

  const session = getSession(currentImageName);
  resizeCanvasToDisplaySize(refs.boardCanvas);

  const width = refs.boardCanvas.width;
  const height = refs.boardCanvas.height;
  boardCtx.save();
  boardCtx.clearRect(0, 0, width, height);
  boardCtx.imageSmoothingEnabled = false;
  boardCtx.drawImage(imageState.sourceCanvas, 0, 0, width, height);
  boardCtx.drawImage(imageState.maskCanvas, 0, 0, width, height);

  if (session.trail.length) {
    const scaleX = width / imageState.size;
    const scaleY = height / imageState.size;
    const pixelScale = Math.min(scaleX, scaleY);

    boardCtx.beginPath();
    for (let i = 0; i < session.trail.length; i += 1) {
      const point = session.trail[i];
      const x = (point.col + 0.5) * scaleX;
      const y = (point.row + 0.5) * scaleY;
      if (i === 0) {
        boardCtx.moveTo(x, y);
      } else {
        boardCtx.lineTo(x, y);
      }
    }
    boardCtx.strokeStyle = "rgba(18, 143, 161, 0.95)";
    boardCtx.lineWidth = Math.max(2, pixelScale * 0.7);
    boardCtx.lineJoin = "round";
    boardCtx.lineCap = "round";
    boardCtx.stroke();

    const anchor = session.trail[0];
    const endpoint = session.trail[session.trail.length - 1];
    drawMarker(anchor, scaleX, scaleY, Math.max(3, pixelScale * 0.9), "#ffffff", "#128fa1");
    drawMarker(endpoint, scaleX, scaleY, Math.max(4, pixelScale * 1.05), "#f0bc42", "#17211c");
  }

  boardCtx.restore();
}

function renderDetailEditor() {
  const imageState = imageCache.get(currentImageName);
  if (!imageState) {
    return;
  }

  const session = getSession(currentImageName);
  ensureDetailView(session, imageState);
  resizeCanvasToDisplaySize(refs.detailCanvas);

  const width = refs.detailCanvas.width;
  const height = refs.detailCanvas.height;
  const windowSize = getDetailWindowSize(imageState);
  const { topRow, leftCol } = session.detailView;
  const cellWidth = width / windowSize;
  const cellHeight = height / windowSize;

  detailCtx.save();
  detailCtx.clearRect(0, 0, width, height);
  detailCtx.imageSmoothingEnabled = false;
  detailCtx.drawImage(
    imageState.sourceCanvas,
    leftCol,
    topRow,
    windowSize,
    windowSize,
    0,
    0,
    width,
    height,
  );
  detailCtx.drawImage(
    imageState.maskCanvas,
    leftCol,
    topRow,
    windowSize,
    windowSize,
    0,
    0,
    width,
    height,
  );

  detailCtx.strokeStyle = "rgba(23, 33, 28, 0.16)";
  detailCtx.lineWidth = 1;
  detailCtx.beginPath();
  for (let i = 0; i <= windowSize; i += 1) {
    const x = Math.round(i * cellWidth) + 0.5;
    detailCtx.moveTo(x, 0);
    detailCtx.lineTo(x, height);
    const y = Math.round(i * cellHeight) + 0.5;
    detailCtx.moveTo(0, y);
    detailCtx.lineTo(width, y);
  }
  detailCtx.stroke();

  if (session.trail.length) {
    detailCtx.save();
    detailCtx.beginPath();
    detailCtx.rect(0, 0, width, height);
    detailCtx.clip();
    detailCtx.beginPath();
    for (let i = 0; i < session.trail.length; i += 1) {
      const point = session.trail[i];
      const x = (point.col - leftCol + 0.5) * cellWidth;
      const y = (point.row - topRow + 0.5) * cellHeight;
      if (i === 0) {
        detailCtx.moveTo(x, y);
      } else {
        detailCtx.lineTo(x, y);
      }
    }
    detailCtx.strokeStyle = "rgba(18, 143, 161, 0.96)";
    detailCtx.lineWidth = Math.max(2, Math.min(cellWidth, cellHeight) * 0.55);
    detailCtx.lineJoin = "round";
    detailCtx.lineCap = "round";
    detailCtx.stroke();
    detailCtx.restore();

    const anchor = session.trail[0];
    const endpoint = getTrailEndpoint(session, imageState.size);
    drawDetailMarker(anchor, leftCol, topRow, windowSize, cellWidth, cellHeight, "#ffffff", "#128fa1");
    drawDetailMarker(endpoint, leftCol, topRow, windowSize, cellWidth, cellHeight, "#f0bc42", "#17211c");
  }

  detailCtx.restore();
}

function drawMarker(cell, scaleX, scaleY, radius, fill, stroke) {
  const x = (cell.col + 0.5) * scaleX;
  const y = (cell.row + 0.5) * scaleY;
  boardCtx.beginPath();
  boardCtx.arc(x, y, radius, 0, Math.PI * 2);
  boardCtx.fillStyle = fill;
  boardCtx.fill();
  boardCtx.lineWidth = Math.max(1.5, radius * 0.35);
  boardCtx.strokeStyle = stroke;
  boardCtx.stroke();
}

function drawDetailMarker(cell, leftCol, topRow, windowSize, cellWidth, cellHeight, fill, stroke) {
  if (
    cell.row < topRow ||
    cell.col < leftCol ||
    cell.row >= topRow + windowSize ||
    cell.col >= leftCol + windowSize
  ) {
    return;
  }

  const x = (cell.col - leftCol + 0.5) * cellWidth;
  const y = (cell.row - topRow + 0.5) * cellHeight;
  const radius = Math.max(4, Math.min(cellWidth, cellHeight) * 0.33);
  detailCtx.beginPath();
  detailCtx.arc(x, y, radius, 0, Math.PI * 2);
  detailCtx.fillStyle = fill;
  detailCtx.fill();
  detailCtx.lineWidth = Math.max(1.5, radius * 0.35);
  detailCtx.strokeStyle = stroke;
  detailCtx.stroke();
}

function updateAllUI() {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState) {
    return;
  }
  syncImageSelectionUI();
  syncSequenceField(session);
  syncDetailLabel(imageState, session);
  syncStats(imageState, session);
  scheduleRender();
}

async function switchImage(name) {
  currentImageName = name;
  syncImageSelectionUI();
  const imageState = await loadImageState(name);
  const session = getSession(name);
  recomputeSession(session, imageState);
  updateAllUI();
}

function appendMovesString(moves) {
  if (!moves) {
    return;
  }

  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState) {
    return;
  }

  ensureAnchor(session, imageState.size);
  ensureDetailView(session, imageState);
  session.moves += moves;

  if (!session.survivorStarts || session.survivorStarts.length !== imageState.whiteStarts.length) {
    resetSimulation(session, imageState);
  }

  for (const move of moves) {
    extendTrail(session, imageState.size, move);
    applyStep(session, imageState, move);
  }

  updateMask(imageState, session);
  updateAllUI();
}

function appendMove(move) {
  appendMovesString(move);
}

function setMoves(nextMoves) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  session.moves = sanitizeMoves(nextMoves);
  recomputeSession(session, imageState);
  updateAllUI();
}

function clearMoves() {
  const session = getSession(currentImageName);
  session.moves = "";
  session.anchor = null;
  const imageState = imageCache.get(currentImageName);
  recomputeSession(session, imageState);
  updateAllUI();
}

function undoMove() {
  const session = getSession(currentImageName);
  if (!session.moves.length) {
    return;
  }
  session.moves = session.moves.slice(0, -1);
  const imageState = imageCache.get(currentImageName);
  recomputeSession(session, imageState);
  updateAllUI();
}

function centerOverlay() {
  const session = getSession(currentImageName);
  const imageState = imageCache.get(currentImageName);
  session.anchor = defaultAnchor(imageState.size);
  rebuildTrail(session, imageState.size);
  centerDetailViewOnCell(session, imageState, getTrailEndpoint(session, imageState.size));
  updateAllUI();
}

function panDetailViewport(direction, step = DETAIL_PAN_STEP) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  ensureDetailView(session, imageState);
  const delta = MOVE_DELTAS[direction];
  session.detailView.topRow += delta.dr * step;
  session.detailView.leftCol += delta.dc * step;
  clampDetailView(session.detailView, imageState);
  syncDetailLabel(imageState, session);
  scheduleRender();
}

function focusDetailOnEndpoint() {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  centerDetailViewOnCell(session, imageState, getTrailEndpoint(session, imageState.size));
  updateAllUI();
}

function getBoardCellFromPointer(event) {
  const imageState = imageCache.get(currentImageName);
  if (!imageState) {
    return null;
  }
  const rect = refs.boardCanvas.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width - 0.0001);
  const y = clamp(event.clientY - rect.top, 0, rect.height - 0.0001);
  const col = Math.floor((x / rect.width) * imageState.size);
  const row = Math.floor((y / rect.height) * imageState.size);
  return { row, col };
}

function getDetailCellFromPointer(event) {
  const imageState = imageCache.get(currentImageName);
  if (!imageState) {
    return null;
  }

  const session = getSession(currentImageName);
  ensureDetailView(session, imageState);
  const rect = refs.detailCanvas.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width - 0.0001);
  const y = clamp(event.clientY - rect.top, 0, rect.height - 0.0001);
  const windowSize = getDetailWindowSize(imageState);
  const localCol = Math.floor((x / rect.width) * windowSize);
  const localRow = Math.floor((y / rect.height) * windowSize);
  return {
    row: session.detailView.topRow + localRow,
    col: session.detailView.leftCol + localCol,
  };
}

function updateHoverLabel(cell) {
  const imageState = imageCache.get(currentImageName);
  if (!cell || !imageState) {
    refs.hoverLabel.textContent = "Hover the board";
    return;
  }
  const index = rowColToIndex(cell.row, cell.col, imageState.size);
  refs.hoverLabel.textContent = `(${cell.row + 1}, ${cell.col + 1}) ${imageState.isBlack[index] ? "black" : "white"}`;
}

function appendMovesTowardCell(targetCell) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  ensureAnchor(session, imageState.size);

  if (!session.trail.length) {
    session.trail = [cloneCell(session.anchor)];
  }

  let current = cloneCell(session.trail[session.trail.length - 1]);
  const pendingMoves = [];

  while (current.row !== targetCell.row || current.col !== targetCell.col) {
    const dr = targetCell.row - current.row;
    const dc = targetCell.col - current.col;
    let move;
    if (Math.abs(dc) > Math.abs(dr)) {
      move = dc > 0 ? "R" : "L";
    } else {
      move = dr > 0 ? "D" : "U";
    }
    pendingMoves.push(move);
    current = {
      row: clamp(current.row + MOVE_DELTAS[move].dr, 0, imageState.size - 1),
      col: clamp(current.col + MOVE_DELTAS[move].dc, 0, imageState.size - 1),
    };
  }

  if (!pendingMoves.length) {
    return;
  }

  appendMovesString(pendingMoves.join(""));
}

function relocatePathAnchor(cell) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState || !cell) {
    return;
  }

  session.anchor = cloneCell(cell);
  rebuildTrail(session, imageState.size);
  centerDetailViewOnCell(session, imageState, cell);
  updateAllUI();
}

function nudgePathAnchor(move) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState) {
    return;
  }

  ensureAnchor(session, imageState.size);
  const delta = MOVE_DELTAS[move];
  relocatePathAnchor({
    row: clamp(session.anchor.row + delta.dr, 0, imageState.size - 1),
    col: clamp(session.anchor.col + delta.dc, 0, imageState.size - 1),
  });
}

function handleDetailPointerDown(event) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState) {
    return;
  }

  if (event.button === 2) {
    ensureDetailView(session, imageState);
    detailInteraction = {
      mode: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTopRow: session.detailView.topRow,
      startLeftCol: session.detailView.leftCol,
    };
    refs.detailCanvas.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0) {
    return;
  }

  const cell = getDetailCellFromPointer(event);
  if (!cell) {
    return;
  }

  detailInteraction = {
    mode: "draw",
    pointerId: event.pointerId,
    targetCell: cell,
  };
  refs.detailCanvas.setPointerCapture(event.pointerId);

  if (!session.moves.length) {
    session.anchor = cloneCell(cell);
    rebuildTrail(session, imageState.size);
    updateAllUI();
  }

  appendMovesTowardCell(cell);
  updateHoverLabel(cell);
}

function handleDetailPointerMove(event) {
  const imageState = imageCache.get(currentImageName);
  const session = getSession(currentImageName);
  if (!imageState) {
    return;
  }

  const hoverCell = getDetailCellFromPointer(event);
  updateHoverLabel(hoverCell);

  if (!detailInteraction || detailInteraction.pointerId !== event.pointerId) {
    return;
  }

  if (detailInteraction.mode === "draw") {
    if (!hoverCell) {
      return;
    }
    if (
      detailInteraction.targetCell &&
      detailInteraction.targetCell.row === hoverCell.row &&
      detailInteraction.targetCell.col === hoverCell.col
    ) {
      return;
    }
    detailInteraction.targetCell = hoverCell;
    appendMovesTowardCell(hoverCell);
    return;
  }

  if (detailInteraction.mode === "pan") {
    const rect = refs.detailCanvas.getBoundingClientRect();
    const windowSize = getDetailWindowSize(imageState);
    const cellWidth = rect.width / windowSize;
    const cellHeight = rect.height / windowSize;
    const deltaCols = Math.round((detailInteraction.startClientX - event.clientX) / cellWidth);
    const deltaRows = Math.round((detailInteraction.startClientY - event.clientY) / cellHeight);
    session.detailView.topRow = detailInteraction.startTopRow + deltaRows;
    session.detailView.leftCol = detailInteraction.startLeftCol + deltaCols;
    clampDetailView(session.detailView, imageState);
    syncDetailLabel(imageState, session);
    scheduleRender();
  }
}

function finishDetailInteraction(event) {
  if (!detailInteraction) {
    return;
  }
  if (event && detailInteraction.pointerId !== event.pointerId) {
    return;
  }
  if (refs.detailCanvas.hasPointerCapture(detailInteraction.pointerId)) {
    refs.detailCanvas.releasePointerCapture(detailInteraction.pointerId);
  }
  detailInteraction = null;
}

function handleSequenceInput(event) {
  if (isSyncingSequenceField) {
    return;
  }
  const sanitized = sanitizeMoves(event.target.value);
  if (sanitized !== event.target.value) {
    event.target.value = sanitized;
  }
  setMoves(sanitized);
}

function handlePointerDown(event) {
  if (event.button !== 0) {
    return;
  }
  const cell = getBoardCellFromPointer(event);
  if (!cell) {
    return;
  }
  relocatePathAnchor(cell);
  updateHoverLabel(cell);
}

function handlePointerMove(event) {
  const cell = getBoardCellFromPointer(event);
  updateHoverLabel(cell);
}

function handleKeydown(event) {
  const moveMap = {
    ArrowUp: "U",
    ArrowDown: "D",
    ArrowLeft: "L",
    ArrowRight: "R",
  };

  if (event.key in moveMap) {
    const activeElement = document.activeElement;
    if (activeElement && activeElement.tagName === "TEXTAREA") {
      return;
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      nudgePathAnchor(moveMap[event.key]);
      return;
    }

    if (event.metaKey || event.altKey) {
      return;
    }

    event.preventDefault();
    appendMove(moveMap[event.key]);
  }
}

function bindEvents() {
  refs.sequenceInput.addEventListener("input", handleSequenceInput);
  refs.undoButton.addEventListener("click", undoMove);
  refs.clearButton.addEventListener("click", clearMoves);
  refs.centerButton.addEventListener("click", centerOverlay);
  refs.focusEndpointButton.addEventListener("click", focusDetailOnEndpoint);

  document.querySelectorAll("[data-pan]").forEach((button) => {
    button.addEventListener("click", () => panDetailViewport(button.dataset.pan));
  });

  refs.boardCanvas.addEventListener("pointerdown", handlePointerDown);
  refs.boardCanvas.addEventListener("pointermove", handlePointerMove);
  refs.boardCanvas.addEventListener("pointerleave", () => updateHoverLabel(null));
  refs.detailCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
  refs.detailCanvas.addEventListener("pointerdown", handleDetailPointerDown);
  refs.detailCanvas.addEventListener("pointermove", handleDetailPointerMove);
  refs.detailCanvas.addEventListener("pointerup", finishDetailInteraction);
  refs.detailCanvas.addEventListener("pointercancel", finishDetailInteraction);
  refs.detailCanvas.addEventListener("pointerleave", () => {
    if (!detailInteraction) {
      updateHoverLabel(null);
    }
  });
  window.addEventListener("keydown", handleKeydown);
  resizeObserver.observe(refs.boardWrap);
  resizeObserver.observe(refs.detailWrap);
  window.addEventListener("resize", scheduleRender);
}

async function init() {
  buildImageSelector();
  bindEvents();
  await switchImage(currentImageName);
}

init().catch((error) => {
  refs.loadingLabel.textContent = "Error";
  refs.hoverLabel.textContent = error.message;
  console.error(error);
});
