# Makefile for GNOME PipeWire Volume Mixer Extension

EXTENSION_UUID = pipewire-volume-mixer@extensions.gnome
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)
SRC_DIR = src
FILES = $(SRC_DIR)/extension.js $(SRC_DIR)/metadata.json $(SRC_DIR)/stylesheet.css $(SRC_DIR)/prefs.js

.PHONY: all install uninstall enable disable restart package clean

all: install enable restart

install:
	@echo "Installing extension..."
	@mkdir -p $(EXTENSION_DIR)
	@cp $(FILES) $(EXTENSION_DIR)/
	@echo "Extension installed to $(EXTENSION_DIR)"

uninstall:
	@echo "Uninstalling extension..."
	@rm -rf $(EXTENSION_DIR)
	@echo "Extension uninstalled"

enable:
	@echo "Enabling extension..."
	@gnome-extensions enable $(EXTENSION_UUID)

disable:
	@echo "Disabling extension..."
	@gnome-extensions disable $(EXTENSION_UUID)

restart:
	@echo "Restarting GNOME Shell..."
	@killall -HUP gnome-shell || true

package:
	@echo "Creating extension package..."
	@cd $(SRC_DIR) && zip -r ../$(EXTENSION_UUID).zip extension.js metadata.json stylesheet.css prefs.js
	@zip -r $(EXTENSION_UUID).zip LICENSE README.md
	@echo "Package created: $(EXTENSION_UUID).zip"

clean:
	@rm -f $(EXTENSION_UUID).zip
	@echo "Cleaned up package files"