// Agent cursor overlay: one borderless, click-through, non-activating panel per
// display, holding a coloured arrow and name badge per agent. Core Animation
// runs the glide and the click ripple in the render server, so this process
// does no per-frame work.
//
// Input: one JSON object per stdin line, the point in top-left points of the
// display it names:
//   {"agent":"Main","label":"Main","color":"#268bd2","kind":"click","display":1,"x":400,"y":300}
// kinds: move | click | drag | scroll | type | key | hide (no point).
// Nothing is written back. The process exits when stdin closes, removing its
// own executable. OMP's display captures leave out every application of this
// executable's name, so no agent's screenshot shows any agent's cursor, while
// the user's own screen recordings do.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <libgen.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const NSTimeInterval IdleHide = 8;
static BOOL ReduceMotion;
static char ExecutablePath[PATH_MAX];

@interface OverlayPanel : NSPanel
@end

@implementation OverlayPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static NSColor *ColorFromHex(id hex) {
	unsigned value = 0x268bd2;
	if ([hex isKindOfClass:NSString.class] && [hex length] == 7 && [hex hasPrefix:@"#"]) {
		NSScanner *scanner = [NSScanner scannerWithString:[hex substringFromIndex:1]];
		unsigned parsed = 0;
		if ([scanner scanHexInt:&parsed] && scanner.atEnd) value = parsed;
	}
	return [NSColor colorWithSRGBRed:((value >> 16) & 0xff) / 255.0
		green:((value >> 8) & 0xff) / 255.0
		blue:(value & 0xff) / 255.0
		alpha:1];
}

// Arrow outline in a 24x24 box, hotspot at (0, 0); y grows up in layer space,
// so the body hangs below and right of the tip.
static CGPathRef CreateArrowPath(void) {
	CGMutablePathRef path = CGPathCreateMutable();
	CGPathMoveToPoint(path, NULL, 0, 0);
	CGPathAddLineToPoint(path, NULL, 0, -19);
	CGPathAddLineToPoint(path, NULL, 5, -14.5);
	CGPathAddLineToPoint(path, NULL, 8.5, -22);
	CGPathAddLineToPoint(path, NULL, 11.5, -20.5);
	CGPathAddLineToPoint(path, NULL, 8, -13.5);
	CGPathAddLineToPoint(path, NULL, 14, -13.5);
	CGPathCloseSubpath(path);
	return path;
}

@interface AgentCursor : NSObject
@property(nonatomic, strong) NSColor *fill;
@property(nonatomic, strong) CALayer *root;
@property(nonatomic, strong) CAShapeLayer *arrow;
@property(nonatomic, strong) CATextLayer *badge;
@property(nonatomic) NSUInteger generation;
@end

@implementation AgentCursor
- (instancetype)initWithLabel:(NSString *)label color:(NSColor *)fill scale:(CGFloat)scale {
	if (!(self = [super init])) return nil;
	_fill = fill;
	_root = [CALayer layer];
	_root.bounds = CGRectMake(0, 0, 1, 1);
	_root.anchorPoint = CGPointZero;
	_root.opacity = 0;
	_arrow = [CAShapeLayer layer];
	CGPathRef path = CreateArrowPath();
	_arrow.path = path;
	CGPathRelease(path);
	_arrow.fillColor = fill.CGColor;
	_arrow.strokeColor = NSColor.whiteColor.CGColor;
	_arrow.lineWidth = 1.5;
	_arrow.lineJoin = kCALineJoinRound;
	_arrow.shadowColor = fill.CGColor;
	_arrow.shadowOpacity = 0.6;
	_arrow.shadowRadius = 6;
	_arrow.shadowOffset = CGSizeZero;
	_arrow.contentsScale = scale;
	[_root addSublayer:_arrow];
	NSFont *font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
	_badge = [CATextLayer layer];
	_badge.string = label;
	_badge.font = (__bridge CFTypeRef)font;
	_badge.fontSize = 11;
	_badge.foregroundColor = NSColor.whiteColor.CGColor;
	_badge.backgroundColor = [fill colorWithAlphaComponent:0.92].CGColor;
	_badge.cornerRadius = 8;
	_badge.alignmentMode = kCAAlignmentCenter;
	_badge.contentsScale = scale;
	CGFloat width = [label sizeWithAttributes:@{ NSFontAttributeName: font }].width + 14;
	_badge.frame = CGRectMake(12, -40, width, 16);
	[_root addSublayer:_badge];
	return self;
}
@end

@interface Overlay : NSObject
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, OverlayPanel *> *panels;
@property(nonatomic, strong) NSMutableDictionary<NSString *, AgentCursor *> *cursors;
@end

@implementation Overlay
- (instancetype)init {
	if (!(self = [super init])) return nil;
	_panels = [NSMutableDictionary dictionary];
	_cursors = [NSMutableDictionary dictionary];
	return self;
}

- (void)build {
	for (OverlayPanel *panel in self.panels.allValues) [panel orderOut:nil];
	[self.panels removeAllObjects];
	for (AgentCursor *cursor in self.cursors.allValues) [cursor.root removeFromSuperlayer];
	[self.cursors removeAllObjects];
	for (NSScreen *screen in NSScreen.screens) {
		NSNumber *display = screen.deviceDescription[@"NSScreenNumber"];
		if (![display isKindOfClass:NSNumber.class]) continue;
		OverlayPanel *panel = [[OverlayPanel alloc] initWithContentRect:screen.frame
			styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
			backing:NSBackingStoreBuffered
			defer:NO];
		panel.opaque = NO;
		panel.backgroundColor = NSColor.clearColor;
		panel.hasShadow = NO;
		panel.ignoresMouseEvents = YES;
		panel.level = NSStatusWindowLevel;
		panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
			NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorFullScreenAuxiliary |
			NSWindowCollectionBehaviorIgnoresCycle;
		panel.hidesOnDeactivate = NO;
		panel.releasedWhenClosed = NO;
		// Read-only sharing keeps the cursor in the user's own recordings; OMP's
		// display captures leave this application out by name.
		panel.sharingType = NSWindowSharingReadOnly;
		NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, screen.frame.size.width, screen.frame.size.height)];
		view.wantsLayer = YES;
		panel.contentView = view;
		[panel setFrame:screen.frame display:NO];
		[panel orderFrontRegardless];
		self.panels[display] = panel;
	}
}

- (void)apply:(NSDictionary *)event {
	NSString *agent = event[@"agent"], *kind = event[@"kind"];
	if (![agent isKindOfClass:NSString.class] || ![kind isKindOfClass:NSString.class]) return;
	if ([kind isEqualToString:@"hide"]) {
		[self.cursors[agent].root removeFromSuperlayer];
		[self.cursors removeObjectForKey:agent];
		return;
	}
	NSNumber *display = event[@"display"], *x = event[@"x"], *y = event[@"y"];
	if (![display isKindOfClass:NSNumber.class] || ![x isKindOfClass:NSNumber.class] || ![y isKindOfClass:NSNumber.class]) return;
	// A display that arrived before the screen-change notification: rebuild
	// the panels once it is an NSScreen.
	if (!self.panels[display]) {
		for (NSScreen *screen in NSScreen.screens) {
			if ([screen.deviceDescription[@"NSScreenNumber"] isEqual:display]) { [self build]; break; }
		}
	}
	OverlayPanel *panel = self.panels[display];
	CALayer *host = panel.contentView.layer;
	if (!panel || !host) return;
	CGFloat height = panel.frame.size.height;
	CGPoint local = CGPointMake(x.doubleValue, height - y.doubleValue);
	AgentCursor *cursor = self.cursors[agent];
	if (!cursor) {
		NSString *label = [event[@"label"] isKindOfClass:NSString.class] ? event[@"label"] : agent;
		cursor = [[AgentCursor alloc] initWithLabel:label color:ColorFromHex(event[@"color"]) scale:panel.backingScaleFactor];
		self.cursors[agent] = cursor;
	}
	BOOL glide = cursor.root.superlayer == host;
	CGPoint from = glide ? (cursor.root.presentationLayer ?: cursor.root).position : local;
	if (!glide) {
		// First show, or the agent moved to another display: appear at the target.
		[cursor.root removeFromSuperlayer];
		cursor.arrow.contentsScale = panel.backingScaleFactor;
		cursor.badge.contentsScale = panel.backingScaleFactor;
		[host addSublayer:cursor.root];
	}
	[CATransaction begin];
	[CATransaction setDisableActions:YES];
	cursor.root.position = local;
	cursor.root.opacity = 1;
	[CATransaction commit];
	[cursor.root removeAnimationForKey:@"fade"];
	BOOL press = [kind isEqualToString:@"click"] || [kind isEqualToString:@"drag"];
	CGFloat distance = hypot(local.x - from.x, local.y - from.y);
	if (glide && !ReduceMotion && distance > 2) {
		CFTimeInterval duration = fmin(0.6, fmax(0.22, 0.12 + 0.09 * log2(distance / 24 + 1)));
		CGMutablePathRef path = CGPathCreateMutable();
		CGPathMoveToPoint(path, NULL, from.x, from.y);
		CGFloat bow = fmin(80, distance * 0.16);
		CGPoint mid = CGPointMake((from.x + local.x) / 2, (from.y + local.y) / 2);
		CGPathAddQuadCurveToPoint(path, NULL,
			mid.x + (local.y - from.y) / distance * bow, mid.y - (local.x - from.x) / distance * bow,
			local.x, local.y);
		CAKeyframeAnimation *move = [CAKeyframeAnimation animationWithKeyPath:@"position"];
		move.path = path;
		CGPathRelease(path);
		move.duration = duration;
		move.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.45 :0 :0.2 :1];
		[cursor.root addAnimation:move forKey:@"glide"];
		if (press) {
			dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(duration * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
				[self ripple:cursor at:local host:host];
			});
		}
	} else if (press) {
		[self ripple:cursor at:local host:host];
	}
	if ([kind isEqualToString:@"type"] || [kind isEqualToString:@"key"]) [self pulse:cursor];
	[self scheduleHide:cursor];
}

- (void)ripple:(AgentCursor *)cursor at:(CGPoint)point host:(CALayer *)host {
	CAShapeLayer *ring = [CAShapeLayer layer];
	CGPathRef circle = CGPathCreateWithEllipseInRect(CGRectMake(-14, -14, 28, 28), NULL);
	ring.path = circle;
	CGPathRelease(circle);
	ring.position = point;
	ring.fillColor = NSColor.clearColor.CGColor;
	ring.strokeColor = cursor.fill.CGColor;
	ring.lineWidth = 2;
	if (cursor.root.superlayer == host) [host insertSublayer:ring below:cursor.root];
	else [host addSublayer:ring];
	CABasicAnimation *scale = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
	scale.fromValue = @(ReduceMotion ? 1 : 0.3);
	scale.toValue = @1.4;
	CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
	fade.fromValue = @0.9;
	fade.toValue = @0;
	CAAnimationGroup *group = [CAAnimationGroup animation];
	group.animations = ReduceMotion ? @[ fade ] : @[ scale, fade ];
	group.duration = 0.45;
	ring.opacity = 0;
	[CATransaction begin];
	[CATransaction setCompletionBlock:^{ [ring removeFromSuperlayer]; }];
	[ring addAnimation:group forKey:@"ripple"];
	[CATransaction commit];
}

- (void)pulse:(AgentCursor *)cursor {
	if (ReduceMotion) return;
	CABasicAnimation *bump = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
	bump.fromValue = @1;
	bump.toValue = @1.12;
	bump.duration = 0.12;
	bump.autoreverses = YES;
	[cursor.badge addAnimation:bump forKey:@"pulse"];
}

- (void)scheduleHide:(AgentCursor *)cursor {
	NSUInteger generation = ++cursor.generation;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(IdleHide * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		if (cursor.generation != generation) return;
		CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
		fade.fromValue = @1;
		fade.toValue = @0;
		fade.duration = 0.25;
		cursor.root.opacity = 0;
		[cursor.root addAnimation:fade forKey:@"fade"];
	});
}
@end

// Removes this executable and its private directory, which OMP created for
// this process alone; called once stdin closes.
static void RemoveExecutable(void) {
	char directory[PATH_MAX];
	if (!ExecutablePath[0] || strcmp(basename(ExecutablePath), "omp-agent-cursor") != 0) return;
	strlcpy(directory, ExecutablePath, sizeof directory);
	char *parent = dirname(directory);
	if (!parent || strncmp(basename(parent), "omp-cursor-", 11) != 0) return;
	unlink(ExecutablePath);
	rmdir(parent);
}

int main(int argc, char **argv) {
	@autoreleasepool {
		if (argc > 0 && !realpath(argv[0], ExecutablePath)) ExecutablePath[0] = 0;
		NSApplication *app = NSApplication.sharedApplication;
		app.activationPolicy = NSApplicationActivationPolicyAccessory;
		ReduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
		Overlay *overlay = [Overlay new];
		[overlay build];
		[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification
			object:nil queue:NSOperationQueue.mainQueue usingBlock:^(__unused NSNotification *note) { [overlay build]; }];
		dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
			char *line = NULL;
			size_t capacity = 0;
			ssize_t length;
			while ((length = getline(&line, &capacity, stdin)) >= 0) {
				@autoreleasepool {
					NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
					id event = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
					if (![event isKindOfClass:NSDictionary.class]) continue;
					dispatch_async(dispatch_get_main_queue(), ^{ [overlay apply:event]; });
				}
			}
			free(line);
			RemoveExecutable();
			_exit(0);
		});
		[app run];
		return 0;
	}
}
