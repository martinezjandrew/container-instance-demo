package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const dataDirectory = "/data"

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type stroke struct {
	Revision int64  `json:"revision"`
	From     point  `json:"from"`
	To       point  `json:"to"`
	Size     int    `json:"size"`
	Color    string `json:"color"`
}

type canvasMetadata struct {
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Background string `json:"background"`
	Revision   int64  `json:"revision"`
}

type canvasServer struct {
	mu       sync.RWMutex
	image    *image.RGBA
	metadata canvasMetadata
	dirty    bool
	logger   *slog.Logger
}

func (s *canvasServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		s.handleHealth(w)
	case r.Method == http.MethodPost && r.URL.Path == "/initialize":
		s.handleInitialize(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/strokes":
		s.handleStrokes(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/flush":
		s.handleFlush(w)
	case r.Method == http.MethodGet && r.URL.Path == "/canvas.png":
		s.handleImage(w)
	case r.Method == http.MethodGet && r.URL.Path == "/metadata":
		s.handleMetadata(w)
	default:
		http.NotFound(w, r)
	}
}

func (s *canvasServer) handleHealth(w http.ResponseWriter) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ready":    true,
		"loaded":   s.image != nil,
		"revision": s.metadata.Revision,
	})
}

func (s *canvasServer) handleInitialize(w http.ResponseWriter, r *http.Request) {
	var requested canvasMetadata
	if err := decodeJSON(r, &requested); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if requested.Width < 128 || requested.Width > 1024 || requested.Height < 128 || requested.Height > 1024 {
		writeError(w, http.StatusBadRequest, "width and height must be between 128 and 1024")
		return
	}
	background, err := parseColor(requested.Background)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.image != nil {
		writeJSON(w, http.StatusOK, s.metadata)
		return
	}

	canvas := image.NewRGBA(image.Rect(0, 0, requested.Width, requested.Height))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: background}, image.Point{}, draw.Src)
	s.image = canvas
	s.metadata = canvasMetadata{
		Width: requested.Width, Height: requested.Height,
		Background: requested.Background, Revision: requested.Revision,
	}
	if err := s.flushLocked(); err != nil {
		s.image = nil
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, s.metadata)
}

func (s *canvasServer) handleStrokes(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Strokes []stroke `json:"strokes"`
	}
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(request.Strokes) == 0 || len(request.Strokes) > 100 {
		writeError(w, http.StatusBadRequest, "strokes must contain between 1 and 100 items")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.image == nil {
		writeError(w, http.StatusConflict, "canvas is not initialized")
		return
	}

	for _, item := range request.Strokes {
		if item.Revision != s.metadata.Revision+1 {
			writeError(w, http.StatusConflict, fmt.Sprintf("expected revision %d", s.metadata.Revision+1))
			return
		}
		if item.Size < 1 || item.Size > 64 {
			writeError(w, http.StatusBadRequest, "brush size must be between 1 and 64")
			return
		}
		brushColor, err := parseColor(item.Color)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if !validPoint(item.From, s.metadata) || !validPoint(item.To, s.metadata) {
			writeError(w, http.StatusBadRequest, "stroke coordinates are outside the canvas")
			return
		}
		drawStroke(s.image, item.From, item.To, item.Size, brushColor)
		s.metadata.Revision = item.Revision
	}
	// Keep the hot path in memory. A background flush persists active canvases,
	// while the snapshot endpoint explicitly flushes before checkpointing.
	s.dirty = true
	writeJSON(w, http.StatusOK, map[string]any{"revision": s.metadata.Revision})
}

func (s *canvasServer) handleFlush(w http.ResponseWriter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.image == nil {
		writeError(w, http.StatusConflict, "canvas is not initialized")
		return
	}
	if err := s.flushLocked(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.metadata)
}

func (s *canvasServer) handleImage(w http.ResponseWriter) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.image == nil {
		writeError(w, http.StatusNotFound, "canvas is not initialized")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	if err := png.Encode(w, s.image); err != nil {
		s.logger.Error("failed to encode canvas", "error", err)
	}
}

func (s *canvasServer) handleMetadata(w http.ResponseWriter) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.image == nil {
		writeError(w, http.StatusNotFound, "canvas is not initialized")
		return
	}
	writeJSON(w, http.StatusOK, s.metadata)
}

func (s *canvasServer) load() error {
	metadataFile, err := os.Open(filepath.Join(dataDirectory, "metadata.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer metadataFile.Close()

	var metadata canvasMetadata
	if err := json.NewDecoder(metadataFile).Decode(&metadata); err != nil {
		return err
	}
	imageFile, err := os.Open(filepath.Join(dataDirectory, "canvas.png"))
	if err != nil {
		return err
	}
	defer imageFile.Close()
	decoded, err := png.Decode(imageFile)
	if err != nil {
		return err
	}
	canvas := image.NewRGBA(decoded.Bounds())
	draw.Draw(canvas, canvas.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	s.image = canvas
	s.metadata = metadata
	return nil
}

func (s *canvasServer) flushIfDirty() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.image == nil || !s.dirty {
		return
	}
	if err := s.flushLocked(); err != nil {
		s.logger.Error("failed to flush canvas", "error", err)
	}
}

func (s *canvasServer) flushLocked() error {
	if err := os.MkdirAll(dataDirectory, 0o755); err != nil {
		return err
	}
	imageTemp := filepath.Join(dataDirectory, "canvas.tmp")
	imageFile, err := os.Create(imageTemp)
	if err != nil {
		return err
	}
	if err := png.Encode(imageFile, s.image); err != nil {
		imageFile.Close()
		return err
	}
	if err := imageFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(imageTemp, filepath.Join(dataDirectory, "canvas.png")); err != nil {
		return err
	}

	metadataTemp := filepath.Join(dataDirectory, "metadata.tmp")
	metadataBytes, err := json.Marshal(s.metadata)
	if err != nil {
		return err
	}
	if err := os.WriteFile(metadataTemp, metadataBytes, 0o644); err != nil {
		return err
	}
	if err := os.Rename(metadataTemp, filepath.Join(dataDirectory, "metadata.json")); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

func drawStroke(canvas *image.RGBA, from, to point, size int, brush color.RGBA) {
	distance := math.Hypot(to.X-from.X, to.Y-from.Y)
	spacing := math.Max(1, float64(size)/4)
	steps := int(math.Ceil(distance / spacing))
	if steps < 1 {
		steps = 1
	}
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		x := from.X + (to.X-from.X)*t
		y := from.Y + (to.Y-from.Y)*t
		stampCircle(canvas, int(math.Round(x)), int(math.Round(y)), size, brush)
	}
}

func stampCircle(canvas *image.RGBA, centerX, centerY, diameter int, brush color.RGBA) {
	radius := float64(diameter) / 2
	limit := int(math.Ceil(radius))
	for y := centerY - limit; y <= centerY+limit; y++ {
		for x := centerX - limit; x <= centerX+limit; x++ {
			if !image.Pt(x, y).In(canvas.Bounds()) {
				continue
			}
			dx := float64(x-centerX) + 0.5
			dy := float64(y-centerY) + 0.5
			if dx*dx+dy*dy <= radius*radius {
				canvas.SetRGBA(x, y, brush)
			}
		}
	}
}

func validPoint(value point, metadata canvasMetadata) bool {
	return !math.IsNaN(value.X) && !math.IsNaN(value.Y) &&
		!math.IsInf(value.X, 0) && !math.IsInf(value.Y, 0) &&
		value.X >= 0 && value.Y >= 0 &&
		value.X < float64(metadata.Width) && value.Y < float64(metadata.Height)
}

func parseColor(value string) (color.RGBA, error) {
	if !colorPattern.MatchString(value) {
		return color.RGBA{}, errors.New("color must be a six-digit hexadecimal RGB value")
	}
	decoded, err := hex.DecodeString(value[1:])
	if err != nil {
		return color.RGBA{}, err
	}
	return color.RGBA{R: decoded[0], G: decoded[1], B: decoded[2], A: 255}, nil
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func main() {
	port := "8080"
	if len(os.Args) > 1 && os.Args[1] != "" {
		port = os.Args[1]
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	server := &canvasServer{logger: logger}
	if err := server.load(); err != nil {
		logger.Error("failed to load canvas", "error", err)
		os.Exit(1)
	}

	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			server.flushIfDirty()
		}
	}()

	httpServer := &http.Server{
		Addr:              net.JoinHostPort("", port),
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
	}
	logger.Info("canvas server listening", "address", httpServer.Addr)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
