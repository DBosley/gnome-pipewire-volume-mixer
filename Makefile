# Makefile for GNOME PipeWire Volume Mixer Extension

EXTENSION_UUID = pipewire-volume-mixer@extensions.gnome
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)
SRC_DIR = src
FILES = $(SRC_DIR)/extension.js $(SRC_DIR)/metadata.json $(SRC_DIR)/stylesheet.css $(SRC_DIR)/prefs.js \
        $(SRC_DIR)/daemonBackend.js $(SRC_DIR)/legacyBackend.js $(SRC_DIR)/sharedMemory.js $(SRC_DIR)/ipcClient.js

.PHONY: all install uninstall enable disable restart package clean daemon-build daemon-install daemon-start daemon-stop daemon-status daemon-restart daemon-reload

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

# Daemon targets
daemon-build:
	@echo "Building PipeWire Volume Mixer Daemon..."
	@cd daemon && cargo build --release --bin pipewire-volume-mixer-daemon

daemon-install: daemon-build
	@echo "Installing daemon..."
	@echo "This will require sudo access to install the daemon binary and config"
	sudo install -m 755 daemon/target/release/pipewire-volume-mixer-daemon /usr/local/bin/
	@mkdir -p $(HOME)/.config/systemd/user/
	@cp daemon/pipewire-volume-mixer-daemon.service $(HOME)/.config/systemd/user/
	sudo mkdir -p /etc/pipewire-volume-mixer
	@[ -f /etc/pipewire-volume-mixer/config.toml ] || sudo cp daemon/config.toml.example /etc/pipewire-volume-mixer/config.toml
	@systemctl --user daemon-reload
	@systemctl --user enable pipewire-volume-mixer-daemon.service
	@echo "Daemon installed and enabled"

daemon-start:
	@echo "Starting daemon..."
	@systemctl --user start pipewire-volume-mixer-daemon.service

daemon-stop:
	@echo "Stopping daemon..."
	@systemctl --user stop pipewire-volume-mixer-daemon.service

daemon-status:
	@systemctl --user status pipewire-volume-mixer-daemon.service

daemon-logs:
	@journalctl --user -u pipewire-volume-mixer-daemon.service -f

daemon-restart: daemon-stop daemon-build daemon-install daemon-start
	@echo "Daemon restarted successfully!"

daemon-reload: daemon-restart
	@echo "Alias for daemon-restart"