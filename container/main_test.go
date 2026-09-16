package main

import (
	"image"
	"image/color"
	"testing"
)

func TestParseColor(t *testing.T) {
	got, err := parseColor("#12aBef")
	if err != nil {
		t.Fatalf("parseColor returned an error: %v", err)
	}
	want := (color.RGBA{R: 0x12, G: 0xab, B: 0xef, A: 0xff})
	if got != want {
		t.Fatalf("parseColor = %#v, want %#v", got, want)
	}

	if _, err := parseColor("red"); err == nil {
		t.Fatal("parseColor accepted a non-hex color")
	}
}

func TestDrawStrokeConnectsEndpoints(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 32, 32))
	brush := color.RGBA{R: 255, A: 255}
	drawStroke(canvas, point{X: 2, Y: 2}, point{X: 29, Y: 29}, 3, brush)

	for coordinate := 2; coordinate <= 29; coordinate++ {
		if got := canvas.RGBAAt(coordinate, coordinate); got != brush {
			t.Fatalf("pixel (%d, %d) = %#v, want %#v", coordinate, coordinate, got, brush)
		}
	}
}

func TestStampCircleClipsAtCanvasEdge(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 8, 8))
	brush := color.RGBA{G: 255, A: 255}
	stampCircle(canvas, 0, 0, 8, brush)

	if got := canvas.RGBAAt(0, 0); got != brush {
		t.Fatalf("edge pixel = %#v, want %#v", got, brush)
	}
}

func TestValidPoint(t *testing.T) {
	metadata := canvasMetadata{Width: 128, Height: 128}
	if !validPoint(point{X: 127.9, Y: 0}, metadata) {
		t.Fatal("validPoint rejected an in-bounds point")
	}
	if validPoint(point{X: 128, Y: 0}, metadata) {
		t.Fatal("validPoint accepted an out-of-bounds point")
	}
}
