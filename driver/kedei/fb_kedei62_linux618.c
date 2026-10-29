// SPDX-License-Identifier: GPL-2.0
/*
 * 2026 Linux 6.18 GPIO-descriptor port, based on:
 * 2019 Tong Zhang <ztong@vt.edu>
 * FBTFT Driver for KeDei 6.2 Display
 */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/gpio/consumer.h>
#include <linux/delay.h>
#include <video/mipi_display.h>
#include <linux/spi/spi.h>
#include <linux/sched.h>
#include <linux/vmalloc.h>
#include <linux/mutex.h>

#include "fbtft.h"

#define DRVNAME		"kedei62"
#define WIDTH		480
#define HEIGHT		320
#define FPS		10


struct kedei62_state {
    struct mutex update_lock;
    bool valid;
    int io_error;
    u16 shadow[WIDTH * HEIGHT];
};

static void free_state(void *state)
{
    vfree(state);
}

static uint8_t lcd_rotations[4] = {
	0b11101010,	//   0
	0b01001010,	//  90
	0b00101010,	// 180
	0b10001010	// 270
};

static uint16_t lcd_h;
static uint16_t lcd_w;

static int write(struct fbtft_par *par, void *buf, size_t len)
{
    int ret;
    gpiod_set_value_cansleep(par->gpio.latch, 1);
    ret = fbtft_write_spi(par, buf, len);
    gpiod_set_value_cansleep(par->gpio.latch, 0);
    if (ret < 0)
        ((struct kedei62_state *)par->extra)->io_error = ret;
    return ret;
}

static void lcd_cmd(struct fbtft_par* par, uint8_t cmd)
{
    u8 *b1 = par->buf;
    b1[0] = 0x11;
	b1[1] = 0x00;
	b1[2] = cmd;
	write(par, &b1[0], 3);
}

static void lcd_data(struct fbtft_par* par, uint8_t dat)
{
    u8 *b1 = par->buf;
    b1[0] = 0x15;
    b1[1] = 0x00;
    b1[2] = dat;
	write(par, &b1[0], 3);
}

static void lcd_setrotation(struct fbtft_par* par, uint8_t m)
{
	lcd_cmd(par,0x36);
    lcd_data(par,lcd_rotations[m]);
	if (m&1) {
		lcd_h = WIDTH;
		lcd_w = HEIGHT;
	} else {
		lcd_h = HEIGHT;
		lcd_w = WIDTH;
	}
}

static void set_addr_win(struct fbtft_par *par, int xs, int ys,
			 int xe, int ye)
{
    
	lcd_cmd(par,0x2A);
	    lcd_data(par,xs>>8);
        lcd_data(par,xs&0xFF);
	    lcd_data(par,xe>>8);
        lcd_data(par,xe&0xFF);
	lcd_cmd(par,0x2B);
	    lcd_data(par,ys>>8);
        lcd_data(par,ys&0xFF);
	    lcd_data(par,ye>>8);
        lcd_data(par,ye&0xFF);
	lcd_cmd(par,0x2C);
}

static int write_vmem(struct fbtft_par *par, size_t offset, size_t len)
{
    u16 *vmem = (u16 *)(par->info->screen_buffer + offset);
    struct kedei62_state *state = par->extra;
    u8 *buf = par->buf;
    size_t i;
    int ret;

    if ((offset | len) & 1)
        return -EINVAL;
    buf[0] = 0x15;
    for (i = 0; i < len; i += 2) {
        u16 pixel = READ_ONCE(vmem[i / 2]);
        buf[1] = pixel >> 8;
        buf[2] = pixel & 0xff;
        ret = write(par, buf, 3);
        if (ret < 0)
            return ret;
        state->shadow[(offset + i) / 2] = pixel;
        if (!(i & 511))
            cond_resched();
    }
    return 0;
}

/* Only transmit changed horizontal spans. A cursor update should not resend
 * full 480-pixel lines or the larger dirty page supplied by fb_deferred_io. */
static void update_display(struct fbtft_par *par, unsigned int start,
                           unsigned int end)
{
    struct kedei62_state *state = par->extra;
    unsigned int width = par->info->var.xres;
    unsigned int height = par->info->var.yres;
    u16 *pixels = (u16 *)par->info->screen_buffer;
    unsigned int y;
    int ret = 0;

    mutex_lock(&state->update_lock);
    if (!state->valid) {
        state->io_error = 0;
        set_addr_win(par, 0, 0, width - 1, height - 1);
        if (state->io_error < 0)
            goto failed;
        ret = write_vmem(par, 0, width * height * 2);
        if (ret < 0)
            goto failed;
        state->valid = true;
        goto out;
    }
    if (start > end || end >= height) {
        start = 0;
        end = height - 1;
    }
    for (y = start; y <= end; y++) {
        unsigned int first = 0, last = width - 1;
        unsigned int base = y * width;

        while (first < width && READ_ONCE(pixels[base + first]) == state->shadow[base + first])
            first++;
        if (first == width)
            continue;
        while (last > first && READ_ONCE(pixels[base + last]) == state->shadow[base + last])
            last--;
        state->io_error = 0;
        set_addr_win(par, first, y, last, y);
        if (state->io_error < 0)
            goto failed;
        ret = write_vmem(par, (base + first) * 2, (last - first + 1) * 2);
        if (ret < 0)
            goto failed;
    }
    goto out;
failed:
    state->valid = false;
    dev_err_ratelimited(par->info->device, "LCD refresh failed: %d\n",
                        ret < 0 ? ret : state->io_error);
out:
    mutex_unlock(&state->update_lock);
}

static void reset(struct fbtft_par *par)
{
	u8 *buff = par->buf;
	buff[0] = 0x00;
	buff[1] = 0x01;
	buff[2] = 0x00;
    buff[3] = 0x00;
    write(par, &buff[0], 4);
	mdelay(50);

	buff[0] = 0x00;
	buff[1] = 0x00;
	buff[2] = 0x00;
	buff[3] = 0x00;
	write(par, &buff[0], 4);
	mdelay(100);
    
	buff[0] = 0x00;
	buff[1] = 0x01;
	buff[2] = 0x00;
	buff[3] = 0x00;
	write(par, &buff[0], 4);
	mdelay(50);
}


static int init_display(struct fbtft_par *par)
{
    struct kedei62_state *state;
    int ret;

    state = vzalloc(sizeof(*state));
    if (!state)
        return -ENOMEM;
    ret = devm_add_action_or_reset(par->info->device, free_state, state);
    if (ret)
        return ret;
    mutex_init(&state->update_lock);
    par->extra = state;
    reset(par);

    lcd_cmd(par,0x00);
    mdelay(10);
    lcd_cmd(par,0xFF); lcd_cmd(par,0xFF);
    mdelay(10);
    lcd_cmd(par,0xFF); lcd_cmd(par,0xFF); lcd_cmd(par,0xFF); lcd_cmd(par,0xFF);
    mdelay(15);
    lcd_cmd(par,0x11);
    mdelay(150);

    lcd_cmd(par,0xB0); lcd_data(par,0x00);
    lcd_cmd(par,0xB3); lcd_data(par,0x02); lcd_data(par,0x00); lcd_data(par,0x00); lcd_data(par,0x00);
    lcd_cmd(par,0xB9); lcd_data(par,0x01); lcd_data(par,0x00); lcd_data(par,0x0F); lcd_data(par,0x0F);
    lcd_cmd(par,0xC0); lcd_data(par,0x13); lcd_data(par,0x3B); lcd_data(par,0x00); lcd_data(par,0x02);
                   lcd_data(par,0x00); lcd_data(par,0x01); lcd_data(par,0x00); lcd_data(par,0x43);
    lcd_cmd(par,0xC1); lcd_data(par,0x08); lcd_data(par,0x0F); lcd_data(par,0x08); lcd_data(par,0x08);
    lcd_cmd(par,0xC4); lcd_data(par,0x11); lcd_data(par,0x07); lcd_data(par,0x03); lcd_data(par,0x04);
    lcd_cmd(par,0xC6); lcd_data(par,0x00);
    lcd_cmd(par,0xC8); lcd_data(par,0x03); lcd_data(par,0x03); lcd_data(par,0x13); lcd_data(par,0x5C);
                   lcd_data(par,0x03); lcd_data(par,0x07); lcd_data(par,0x14); lcd_data(par,0x08);
                   lcd_data(par,0x00); lcd_data(par,0x21); lcd_data(par,0x08); lcd_data(par,0x14);
                   lcd_data(par,0x07); lcd_data(par,0x53); lcd_data(par,0x0C); lcd_data(par,0x13);
                   lcd_data(par,0x03); lcd_data(par,0x03); lcd_data(par,0x21); lcd_data(par,0x00);
    lcd_cmd(par,0x35); lcd_data(par,0x00);
    lcd_cmd(par,0x36); lcd_data(par,0x60);
    lcd_cmd(par,0x3A); lcd_data(par,0x55);
    lcd_cmd(par,0x44); lcd_data(par,0x00); lcd_data(par,0x01);
    lcd_cmd(par,0xD0); lcd_data(par,0x07); lcd_data(par,0x07); lcd_data(par,0x1D); lcd_data(par,0x03);
    lcd_cmd(par,0xD1); lcd_data(par,0x03); lcd_data(par,0x30); lcd_data(par,0x10);
    lcd_cmd(par,0xD2); lcd_data(par,0x03); lcd_data(par,0x14); lcd_data(par,0x04);
    lcd_cmd(par,0x29);

    mdelay(30);

    lcd_cmd(par,0x2A); lcd_data(par,0x00); lcd_data(par,0x00); lcd_data(par,0x01); lcd_data(par,0x3F);
    lcd_cmd(par,0x2B); lcd_data(par,0x00); lcd_data(par,0x00); lcd_data(par,0x01); lcd_data(par,0xE0);
    lcd_cmd(par,0xB4); lcd_data(par,0x00);

    lcd_cmd(par,0x2C);

    mdelay(10);
    lcd_setrotation(par,0);

    //lcd_fill(par,0x0); //black out the screen.
    dev_info(par->info->device, "KeDei V6.2 initialized with changed-span refresh\n");
    return state->io_error;
}

static int verify_gpios(struct fbtft_par *par)
{
    return par->gpio.latch ? 0 : -EINVAL;
}

static int set_var(struct fbtft_par *par)
{
    ((struct kedei62_state *)par->extra)->valid = false;
    switch (par->info->var.rotate) {
    case 0: lcd_setrotation(par, 0); break;
    case 90: lcd_setrotation(par, 1); break;
    case 180: lcd_setrotation(par, 2); break;
    case 270: lcd_setrotation(par, 3); break;
    default: return -EINVAL;
    }
    return 0;
}

static struct fbtft_display display = {
	.regwidth = 8,
	.width = WIDTH,
	.height = HEIGHT,
	.fps = FPS,
	.fbtftops = {
        .write = write,
        .write_vmem = write_vmem,
        .update_display = update_display,
		.set_addr_win = set_addr_win,
        .reset = reset,
		.init_display = init_display,
        .set_var = set_var,
        .verify_gpios = verify_gpios,
	},
};

FBTFT_REGISTER_SPI_DRIVER(DRVNAME, "kedei", "kedei62", &display);

MODULE_ALIAS("spi:" DRVNAME);
MODULE_ALIAS("platform:" DRVNAME);
MODULE_ALIAS("spi:kedei62");
MODULE_ALIAS("platform:kedei62");

MODULE_DESCRIPTION("FB driver for KeDei6.2 display");
MODULE_AUTHOR("Tong Zhang<ztong@vt.edu>");
MODULE_LICENSE("GPL");

