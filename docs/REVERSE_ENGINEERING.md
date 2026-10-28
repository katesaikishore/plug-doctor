# When no driver exists: reverse engineering a USB device

Most "unsupported" devices are not mysteries. They are a known chip behind a vendor's label, or a standard device class with a quirk. Work through these levels in order and stop as soon as something works.

## 1. Find out what it really is

Plug Doctor's *Under the hood* tab shows:

- **Vendor:product ID.** Search it (for example `"1a86:7523"`). The vendor ID often belongs to the chip maker, not the brand on the box: many "brand X" serial cables are a WCH, Silicon Labs or FTDI chip.
- **Interface classes.** Class `07` is a printer, `08` storage, `03` HID, `02`/`0a` serial (CDC), `0e` video, `ff` vendor-specific. A standard class usually means a generic driver already exists.
- **Printers: the IEEE 1284 ID.** `CMD:` lists the page languages it speaks. `POSTSCRIPT`, `PCLXL` or `PCL` means a generic driver will work. `URF` or `PWG` means driverless AirPrint / IPP Everywhere. `ACL`, `ZJS`, `GDI`, `LIDIL`, `CAPT` or `SPL` means a host-based printer that needs model-specific software.

## 2. Look for existing work

- [OpenPrinting](https://openprinting.github.io/) for printers, and their driver database
- [linux-hardware.org](https://linux-hardware.org) for which kernel driver claims a given ID
- Kernel sources: `git grep -i "0x7523"` in `drivers/` finds the driver that handles an ID
- Projects such as foo2zjs, splix, gutenprint, HPLIP, SANE and libgphoto2
- GitHub issues of projects for similar devices

## 3. Watch what the official driver does

If the vendor ships a driver for *any* OS, its USB traffic is the specification.

| OS | Capture |
| --- | --- |
| Linux | `sudo modprobe usbmon`, then capture the `usbmonN` interface in Wireshark |
| Windows | Wireshark with USBPcap |
| macOS | Hard on Apple Silicon. Run the vendor's Windows driver in a VM with USB passthrough, or capture on a Linux host. |

Record one action at a time (power on, print one page, read one value) so each capture is easy to read. Compare captures to find the parts that change.

## 4. Replay it

Once you know the messages, small userspace programs (Python with `pyusb`, or Node with `usb`) can send the same bytes. That is often enough to make a device work. It can also become a CUPS filter, a SANE backend or a small daemon.

## 5. Share it

Write a recipe ([ADDING_A_DEVICE.md](ADDING_A_DEVICE.md)) or open an issue with your device report and captures. Someone else with the same device will thank you.

Only reverse engineer devices you own, and respect licenses and local law. Interoperability is the goal.
