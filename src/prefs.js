/* prefs.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const { Gtk } = imports.gi;

// eslint-disable-next-line no-unused-vars
function init() {
}

// eslint-disable-next-line no-unused-vars
function buildPrefsWidget() {
    // Create a parent widget that we'll return from this function
    let prefsWidget = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 10,
        margin_end: 10,
    });

    // Add a simple label for now
    let label = new Gtk.Label({
        label: '<b>Virtual Audio Sinks Extension</b>',
        use_markup: true,
        xalign: 0
    });
    prefsWidget.append(label);
    
    let infoLabel = new Gtk.Label({
        label: 'Configure virtual sinks through PipeWire configuration files.\nSee README for details.',
        wrap: true,
        xalign: 0
    });
    prefsWidget.append(infoLabel);

    // Return our widget which will be added to the window
    return prefsWidget;
}